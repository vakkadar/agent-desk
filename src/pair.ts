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
import { AgentStore, agentCommand, agentLabel, type AgentId } from "./agents.js";

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

type Role = "builder" | "reviewer";
/** One pane in the in-page pane view. running: an agent is up (not back at the shell prompt). */
export interface PaneView { tab: string; role: Role; pane: string; agent: AgentId; label: string; screen: string; running: boolean }
/** Pane title in herdr and in the page: "code-2 · builder · Claude Code". */
export const paneLabel = (tab: string, role: Role, agent: AgentId) => `${tab} · ${role} · ${agentLabel(agent)}`;
const ROLES: Role[] = ["builder", "reviewer"];
const TRUST = /Yes, I trust this folder/;
/** The pane's agent has exited and its shell is back: last non-empty line is a prompt ("user@host:dir$"). */
export const atShell = (screen: string) => {
  // A narrow pane wraps a long prompt over several lines: try the last line, then it joined to the ones above.
  const ls = screen.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-6);
  for (let k = ls.length - 1; k >= 0; k--) if (/(^|\s)[\w.-]+@[\w.-]+:.*[$#]$/.test(ls.slice(k).join(""))) return true;
  return false;
};

export const sessionName =(sourceId: string) => `desk-${sourceId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);

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

  list(): PairRec[] { return Object.values(this.all()); }

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
    if (have && livePanes.has(have.builder) && livePanes.has(have.reviewer)) {
      // Panes are there, but an agent may have exited (or a restored session failed to resume): start it again.
      const cmd = commands(have.builderAgent ?? "claude", have.reviewerAgent ?? rec.reviewerAgent, models, pick.paths);
      for (const r of ROLES) if (atShell(await this.screen(session, have[r]))) await this.herdr(session, ["pane", "run", have[r], cmd[r]]);
      return rec;
    }

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
    await this.herdr(session, ["pane", "rename", builder, paneLabel(tab, "builder", bAgent)]).catch(() => {});
    await this.herdr(session, ["pane", "rename", reviewer, paneLabel(tab, "reviewer", rAgent)]).catch(() => {});
    rec.tabs[tab] = { tab: tabId, builder, reviewer, builderAgent: bAgent, reviewerAgent: rAgent };
    this.put(rec);
    return rec;
  }

  /** Type a message into the builder or reviewer pane and press Enter (the pair's own TUI handles it). */
  async sendTo(sourceId: string, tab: string, role: "builder" | "reviewer", text: string): Promise<void> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) throw new Error(`no ${tab} pair open for ${sourceId}`);
    // Never type a message into a bare shell: it would run as a command.
    if (atShell(await this.screen(rec.session, t[role]))) throw new Error(`${tab}: the ${role} agent is not running (open the pair again to restart it)`);
    await this.herdr(rec.session, ["pane", "send-text", t[role], text]);
    await this.herdr(rec.session, ["pane", "send-keys", t[role], "enter"]);
  }

  /** Claude panes of a tab sitting on Claude's "trust this folder?" screen (first run in a folder).
   *  Polls up to waitMs: Claude takes a moment to draw it. */
  async trustPending(sourceId: string, tab: string, waitMs = 6000): Promise<Role[]> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) return [];
    const roles = ROLES.filter((r) => (r === "builder" ? t.builderAgent ?? "claude" : t.reviewerAgent ?? rec.reviewerAgent) === "claude");
    if (!roles.length) return [];
    const until = Date.now() + waitMs;
    for (;;) {
      const hit: Role[] = [];
      for (const r of roles) if (TRUST.test(await this.screen(rec.session, t[r]))) hit.push(r);
      if (hit.length || Date.now() >= until) return hit;
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  /** Answer "Yes, I trust this folder" in each of the tab's panes still asking (the user tapped Trust). */
  async acceptTrust(sourceId: string, tab: string): Promise<Role[]> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) throw new Error(`no ${tab} pair open for ${sourceId}`);
    const done: Role[] = [];
    for (const r of await this.trustPending(sourceId, tab, 0)) {
      // Options: "❯ No, exit" then "Yes, I trust this folder". Move to Yes unless already there.
      const onYes = /❯\s*Yes, I trust this folder/.test(await this.screen(rec.session, t[r]));
      await this.herdr(rec.session, ["pane", "send-keys", t[r], ...(onYes ? [] : ["down"]), "enter"]);
      done.push(r);
    }
    if (!done.length) throw new Error(`${tab}: no pane is asking to trust its folder`);
    return done;
  }

  /** What a pair pane shows now (empty when the tab is gone). */
  async screenOf(sourceId: string, tab: string, role: Role): Promise<string> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    return rec && t ? this.screen(rec.session, t[role]) : "";
  }

  /** Press keys or type text in a pair pane, as the user would (answers a question the pane shows). */
  async typeInto(sourceId: string, tab: string, role: Role, step: { keys: string[] } | { text: string }): Promise<void> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) throw new Error(`no ${tab} pair open for ${sourceId}`);
    if ("text" in step) await this.herdr(rec.session, ["pane", "send-text", t[role], step.text]);
    else await this.herdr(rec.session, ["pane", "send-keys", t[role], ...step.keys]);
  }

  private async screen(session: string, pane: string): Promise<string> {
    const s = await this.herdr(session, ["pane", "read", pane, "--source", "visible"]).catch(() => "");
    return typeof s === "string" ? s : JSON.stringify(s ?? "");
  }

  /** The panes of the given tabs (all open tabs when none given): which agent runs where and what it shows now. */
  async view(sourceId: string, tabs?: string[]): Promise<PaneView[]> {
    const rec = this.get(sourceId);
    if (!rec) return [];
    const out: PaneView[] = [];
    for (const name of tabs ?? Object.keys(rec.tabs)) {
      const t = rec.tabs[name];
      if (!t) continue;
      for (const role of ROLES) {
        const agent = (role === "builder" ? t.builderAgent ?? "claude" : t.reviewerAgent ?? rec.reviewerAgent);
        const screen = await this.screen(rec.session, t[role]);
        out.push({ tab: name, role, pane: t[role], agent, label: paneLabel(name, role, agent), screen, running: !atShell(screen) });
      }
    }
    return out;
  }

  /** Switch the agent in one pane of a tab (Claude ⇄ Codex …): its pane is replaced, the layout stays builder | reviewer. */
  async swapAgent(sourceId: string, tab: string, role: Role, agent: AgentId, cwd: string, models: PairModels): Promise<PairRec> {
    const rec = this.get(sourceId);
    const t = rec?.tabs[tab];
    if (!rec || !t) throw new Error(`no ${tab} pair open for ${sourceId}`);
    const pick = this.pick();
    const path = pick.paths[agent];
    if (!path) throw new Error(`${agentLabel(agent)} is not installed here`);
    const other: Role = role === "builder" ? "reviewer" : "builder";
    // The new pane goes right of the other one; a new builder then swaps back to the left.
    const fresh: string = (await this.herdr(rec.session, ["pane", "split", t[other], "--direction", "right", "--cwd", cwd])).pane.pane_id;
    await this.herdr(rec.session, ["pane", "close", t[role]]).catch(() => {});
    if (role === "builder") await this.herdr(rec.session, ["pane", "swap", "--source-pane", fresh, "--target-pane", t.reviewer]).catch(() => {});
    await this.herdr(rec.session, ["pane", "run", fresh, agentCommand(agent, path, models[role])]);
    await this.herdr(rec.session, ["pane", "rename", fresh, paneLabel(tab, role, agent)]).catch(() => {});
    t[role] = fresh;
    if (role === "builder") t.builderAgent = agent; else t.reviewerAgent = agent;
    this.put(rec);
    return rec;
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
