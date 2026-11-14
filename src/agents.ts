// Coding agents the project pair can run in its herdr panes, and which ones this desk uses.
//
// Known: Claude Code, Codex, opencode. Each is found on PATH or in its usual install folder.
// Settings (<data>/agents.json, set from the desk's Settings dialog):
//   { "enabled": ["claude", "opencode"], "builder": "claude", "reviewer": "opencode" }
// enabled: the agents this desk may use (any number). builder / reviewer: one of them each;
// both may be the same agent. Missing or stale settings fall back to what is installed:
// builder Claude when present, reviewer the first other installed agent (else the builder).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type AgentId = "claude" | "codex" | "opencode";
export const AGENT_IDS: AgentId[] = ["claude", "codex", "opencode"];

interface Known { label: string; bin: string; dirs: string[] }
const KNOWN: Record<AgentId, Known> = {
  claude: { label: "Claude Code", bin: "claude", dirs: [".local/bin", ".claude/local"] },
  codex: { label: "Codex", bin: "codex", dirs: [".npm-global/bin", ".local/bin"] },
  opencode: { label: "opencode", bin: "opencode", dirs: [".opencode/bin", ".local/bin"] },
};

export interface AgentInfo { id: AgentId; label: string; installed: boolean; path?: string }
export interface AgentSettings { enabled: AgentId[]; builder: AgentId; reviewer: AgentId }

/** Full path of an agent's binary, or undefined when it is not on this machine. */
export function findAgent(id: AgentId, path = process.env.PATH ?? "", home = homedir()): string | undefined {
  const k = KNOWN[id];
  const dirs = [...path.split(delimiter).filter(Boolean), ...k.dirs.map((d) => join(home, d))];
  for (const d of dirs) if (existsSync(join(d, k.bin))) return join(d, k.bin);
  return undefined;
}

export function detectAgents(find: (id: AgentId) => string | undefined = (id) => findAgent(id)): AgentInfo[] {
  return AGENT_IDS.map((id) => {
    const p = find(id);
    return { id, label: KNOWN[id].label, installed: !!p, ...(p ? { path: p } : {}) };
  });
}

const isId = (v: unknown): v is AgentId => typeof v === "string" && (AGENT_IDS as string[]).includes(v);

/** Make settings usable on this machine: only installed agents, builder/reviewer among the enabled. */
export function resolveSettings(raw: Partial<AgentSettings> | undefined, agents: AgentInfo[]): AgentSettings {
  const installed = agents.filter((a) => a.installed).map((a) => a.id);
  let enabled = (Array.isArray(raw?.enabled) ? raw!.enabled.filter(isId) : installed).filter((id) => installed.includes(id));
  if (!enabled.length) enabled = installed.length ? installed : ["claude"];
  const builder = isId(raw?.builder) && enabled.includes(raw!.builder) ? raw!.builder : enabled.includes("claude") ? "claude" : enabled[0];
  const reviewer = isId(raw?.reviewer) && enabled.includes(raw!.reviewer) ? raw!.reviewer : enabled.find((id) => id !== builder) ?? builder;
  return { enabled, builder, reviewer };
}

/** Check a settings change from the browser; throws with a message the dialog can show. */
export function validateSettings(v: any, agents: AgentInfo[]): AgentSettings {
  const installed = new Set(agents.filter((a) => a.installed).map((a) => a.id));
  if (!v || !Array.isArray(v.enabled) || !v.enabled.length) throw new Error("pick at least one agent");
  const enabled = [...new Set(v.enabled)] as unknown[];
  for (const id of enabled) {
    if (!isId(id)) throw new Error(`unknown agent ${String(id)}`);
    if (!installed.has(id)) throw new Error(`${KNOWN[id].label} is not installed here`);
  }
  if (!isId(v.builder) || !enabled.includes(v.builder)) throw new Error("builder must be one of the enabled agents");
  if (!isId(v.reviewer) || !enabled.includes(v.reviewer)) throw new Error("reviewer must be one of the enabled agents");
  return { enabled: enabled as AgentId[], builder: v.builder, reviewer: v.reviewer };
}

export class AgentStore {
  readonly file: string;
  constructor(dataDir: string, private detect: () => AgentInfo[] = () => detectAgents()) {
    this.file = join(dataDir, "agents.json");
  }
  agents(): AgentInfo[] { return this.detect(); }
  private raw(): Partial<AgentSettings> | undefined {
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return undefined; }
  }
  settings(agents = this.agents()): AgentSettings { return resolveSettings(this.raw(), agents); }
  save(v: unknown): AgentSettings {
    const s = validateSettings(v, this.agents());
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(s, null, 2) + "\n");
    renameSync(this.file + ".tmp", this.file);
    return s;
  }
  /** What the Settings dialog shows. */
  view(): { agents: AgentInfo[]; settings: AgentSettings } {
    const agents = this.agents();
    return { agents: agents.map(({ path: _p, ...a }) => a) as AgentInfo[], settings: this.settings(agents) };
  }
}

const q = (s: string) => (/^[A-Za-z0-9_./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Shell command a pair pane runs for an agent. Claude gets a model; the others use their own config. */
export function agentCommand(id: AgentId, path: string | undefined, model?: string): string {
  const bin = q(path ?? KNOWN[id].bin);
  return id === "claude" && model ? `${bin} --model ${q(model)}` : bin;
}

export const agentLabel = (id: AgentId) => KNOWN[id]?.label ?? id;
