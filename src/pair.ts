// Project pair in herdr: one herdr session per opened project, one tab per thread, each tab split
// vertically into builder | reviewer. The desk only views these panes; closing a view stops nothing.
//
//   herdr session  desk-<sourceId>
//     workspace    <sourceId>            (label)
//       tab        lead                  builder pane | reviewer pane   (project leads)
//       tab        code-1                builder pane | reviewer pane   (one per thread)
//
// Builder and reviewer agents come from Settings (src/agents.ts: Claude Code, Codex, opencode),
// picked when a project's pair is first opened; Claude runs with a model, the others with their own config.
// Pane ids are kept in <data>/.index/pairs.json so a restarted desk finds the same panes.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { AgentStore, agentCommand, type AgentId } from "./agents.js";

const exec = promisify(execFile);

/** Runs one herdr CLI call for a session and returns its parsed JSON result (or null). */
export type Herdr = (session: string, args: string[]) => Promise<any>;

export interface PairModels {
  builder: string; // e.g. "sonnet"
  reviewer: string; // e.g. "opus" (used when the reviewer is Claude)
}

export interface TabPanes { tab: string; builder: string; reviewer: string; builderAgent?: AgentId; reviewerAgent?: AgentId }
export interface PairRec {
  sourceId: string;
  session: string;
  workspace: string;
  builderAgent?: AgentId; // the Settings pick when last opened (missing in old records: Claude)
  reviewerAgent: AgentId; // each tab keeps the agents it was started with
  tabs: Record<string, TabPanes>; // "lead" | thread id
}

export const sessionName = (sourceId: string) => `desk-${sourceId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);

/** Env without HERDR_*: herdr refuses some calls when it thinks it runs inside its own pane. */
function cleanEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("HERDR_")) e[k] = v;
  return e;
}

export function herdrCli(bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Herdr {
  return async (session, args) => {
    const { stdout } = await exec(bin, ["--session", session, ...args], { env: cleanEnv(), timeout: 30_000 });
    const t = stdout.trim();
    if (!t) return null;
    try { return JSON.parse(t)?.result ?? null; } catch { return t; }
  };
}

export function onPath(cmd: string, path = process.env.PATH ?? ""): boolean {
  return path.split(delimiter).some((d) => d && existsSync(join(d, cmd)));
}

/** Which agents a new pair runs, and where their binaries are. */
export interface PairPick { builder: AgentId; reviewer: AgentId; paths: Partial<Record<AgentId, string>> }

export function commands(builder: AgentId, reviewer: AgentId, m: PairModels, paths: PairPick["paths"] = {}): { builder: string; reviewer: string } {
  return { builder: agentCommand(builder, paths[builder], m.builder), reviewer: agentCommand(reviewer, paths[reviewer], m.reviewer) };
}

/** The pick from <data>/agents.json (Settings), resolved against what is installed. */
export function storePick(store: AgentStore): () => PairPick {
  return () => {
    const agents = store.agents();
    const s = store.settings(agents);
    return { builder: s.builder, reviewer: s.reviewer, paths: Object.fromEntries(agents.filter((a) => a.path).map((a) => [a.id, a.path!])) };
  };
}

export class Pairs {
  readonly file: string;
  constructor(
    dataDir: string,
    private herdr: Herdr = herdrCli(),
    private startServer: (session: string, cwd: string) => Promise<void> = startHerdrServer,
    private pick: () => PairPick = storePick(new AgentStore(dataDir)),
  ) {
    this.file = join(dataDir, ".index", "pairs.json");
  }

  private all(): Record<string, PairRec> {
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return {}; }
  }

  private put(rec: PairRec): void {
    const all = this.all();
    all[rec.sourceId] = rec;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(all, null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
  }

  get(sourceId: string): PairRec | undefined { return this.all()[sourceId]; }

  /** Open (or re-find) the project's herdr session and the builder | reviewer tab for `tab`. */
  async open(sourceId: string, cwd: string, tab = "lead", models: PairModels = { builder: "sonnet", reviewer: "opus" }): Promise<PairRec> {
    const session = sessionName(sourceId);
    await this.startServer(session, cwd);
    let rec = this.get(sourceId);
    const wsList: any[] = (await this.herdr(session, ["workspace", "list"]))?.workspaces ?? [];
    let ws = wsList.find((w) => w.label === sourceId)?.workspace_id as string | undefined;
    let firstPane: string | undefined;
    if (!ws) {
      const r = await this.herdr(session, ["workspace", "create", "--cwd", cwd, "--label", sourceId, "--no-focus"]);
      ws = r.workspace.workspace_id as string;
      firstPane = r.root_pane.pane_id;
      await this.herdr(session, ["tab", "rename", r.tab.tab_id, "lead"]).catch(() => {});
    }
    const pick = this.pick();
    if (!rec || rec.workspace !== ws) rec = { sourceId, session, workspace: ws, reviewerAgent: pick.reviewer, tabs: {} };
    rec.builderAgent = pick.builder;
    rec.reviewerAgent = pick.reviewer;

    const livePanes = new Set<string>(((await this.herdr(session, ["pane", "list"]))?.panes ?? []).map((p: any) => p.pane_id));
    const have = rec.tabs[tab];
    if (have && livePanes.has(have.builder) && livePanes.has(have.reviewer)) return rec;

    let tabId: string, builder: string, freshBuilder = true;
    if (tab === "lead" && firstPane) {
      tabId = `${ws}:t1`; builder = firstPane;
    } else {
      const tabs: any[] = (await this.herdr(session, ["tab", "list", "--workspace", ws]))?.tabs ?? [];
      const found = tabs.find((t) => t.label === tab);
      if (found && have && livePanes.has(have.builder)) { tabId = found.tab_id; builder = have.builder; freshBuilder = false; }
      else {
        const r = await this.herdr(session, ["tab", "create", "--workspace", ws, "--cwd", cwd, "--label", tab, "--no-focus"]);
        tabId = r.tab.tab_id; builder = r.root_pane.pane_id;
      }
    }
    const split = await this.herdr(session, ["pane", "split", builder, "--direction", "right", "--cwd", cwd]);
    const reviewer: string = split.pane.pane_id;
    // A live builder keeps its agent; a fresh tab gets the current Settings pick.
    const bAgent = (!freshBuilder && have?.builderAgent) || (!freshBuilder ? "claude" : pick.builder);
    const rAgent = (!freshBuilder && have?.reviewerAgent) || pick.reviewer;
    const cmd = commands(bAgent, rAgent, models, pick.paths);
    if (freshBuilder) await this.herdr(session, ["pane", "run", builder, cmd.builder]); // never type into a running agent
    await this.herdr(session, ["pane", "run", reviewer, cmd.reviewer]);
    rec.tabs[tab] = { tab: tabId, builder, reviewer, builderAgent: bAgent, reviewerAgent: rAgent };
    this.put(rec);
    return rec;
  }

  /** Type a message into the builder or reviewer pane and press Enter (the pair's own TUI handles it). */
  async sendTo(sourceId: string, tab: string, role: "builder" | "reviewer", text: string): Promise<void> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) throw new Error(`no ${tab} pair open for ${sourceId}`);
    await this.herdr(rec.session, ["pane", "send-text", t[role], text]);
    await this.herdr(rec.session, ["pane", "send-keys", t[role], "enter"]);
  }

  /** Close one thread's tab (its two agents stop). The project session stays. */
  async closeTab(sourceId: string, tab: string): Promise<void> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) return;
    await this.herdr(rec.session, ["tab", "close", t.tab]).catch(() => {});
    delete rec.tabs[tab];
    this.put(rec);
  }

  /** Command a terminal view runs to show the pair (read-only view over the herdr session). */
  attachCommand(sourceId: string): string[] {
    return ["herdr", "session", "attach", sessionName(sourceId)];
  }
}

/** Start the headless herdr server for a session if it is not up yet. */
export async function startHerdrServer(session: string, cwd: string, bin = process.env.AGENT_DESK_HERDR_BIN || "herdr"): Promise<void> {
  const up = async () => {
    try { await exec(bin, ["--session", session, "workspace", "list"], { env: cleanEnv(), timeout: 5_000 }); return true; } catch { return false; }
  };
  if (await up()) return;
  const { spawn } = await import("node:child_process");
  const child = spawn(bin, ["--session", session, "server"], { cwd, env: cleanEnv(), detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await up()) return;
  }
  throw new Error(`herdr session ${session} did not start`);
}
