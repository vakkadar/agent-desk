import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CfAccessOpts } from "./net/cfaccess.js";
import { parseSchedules, type Schedule } from "./schedule.js";

export interface DeskConfig {
  dataDir: string;
  /** Folder for the built-in General source (general_dir in desk.toml; "~/" expands). */
  generalDir: string;
  keyword: string; // message prefix, FR-12
  port: number;
  network: {
    bind: string[];
    actionAllow: string[];
    readonlyAllow: string[];
    actionToken?: string; // NFR-5; prefer env AGENT_DESK_TOKEN
    cfAccess?: CfAccessOpts; // required to admit Cloudflare Tunnel traffic
  };
  agent: string;
  mux: string;
  git: { push: boolean; remote: string }; // FR-22: push is opt-in
  /** Minutes before a pending approval auto-denies, per mode ([approval_timeout_min] in desk.toml). */
  approvalTimeoutMin: Record<"ask" | "design" | "code", number>;
  /**
   * Claude --permission-mode per source id or thread mode ([permission_mode] in desk.toml).
   * Source id wins over mode. Unlisted → "default" (every tool asks in the browser).
   * In "auto", Claude decides; only what it would ask about reaches the browser.
   */
  permissionMode: Record<string, string>;
  /** Your own herdr sessions to look in for an open Claude per folder (live_sessions; [] turns it off). */
  liveSessions: string[];
  /** Context window in tokens, for the /compact hint (context_limit). */
  contextLimit: number;
  /** Scheduled prompts ([[schedule]] in desk.toml). */
  schedules: Schedule[];
}

export const DEFAULTS: DeskConfig = {
  dataDir: join(homedir(), "agent-desk-data"),
  generalDir: join(homedir(), "agent-desk-data", "general"),
  keyword: "browser",
  port: 7420,
  network: { bind: ["127.0.0.1"], actionAllow: ["127.0.0.1", "::1"], readonlyAllow: [] },
  agent: "claude",
  mux: "herdr",
  git: { push: false, remote: "origin" },
  approvalTimeoutMin: { ask: 30, design: 30, code: 30 },
  permissionMode: { general: "auto" },
  liveSessions: ["default"],
  contextLimit: 200_000,
  schedules: [],
};

/** Load desk.toml from the data dir; missing file → defaults. */
export async function loadConfig(dataDir = process.env.AGENT_DESK_DATA ?? DEFAULTS.dataDir): Promise<DeskConfig> {
  let raw: Record<string, any> = {};
  try {
    raw = parse(await readFile(join(dataDir, "desk.toml"), "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const net = raw.network ?? {};
  return {
    dataDir,
    generalDir: raw.general_dir ? String(raw.general_dir).replace(/^~(?=\/|$)/, homedir()) : join(dataDir, "general"),
    keyword: raw.keyword ?? DEFAULTS.keyword,
    port: raw.port ?? DEFAULTS.port,
    network: {
      bind: net.bind ?? DEFAULTS.network.bind,
      actionAllow: net.action_allow ?? DEFAULTS.network.actionAllow,
      readonlyAllow: net.readonly_allow ?? DEFAULTS.network.readonlyAllow,
      actionToken: process.env.AGENT_DESK_TOKEN ?? net.action_token,
      cfAccess: net.cloudflare_access
        ? { team: net.cloudflare_access.team, aud: net.cloudflare_access.aud, emails: net.cloudflare_access.emails }
        : undefined,
    },
    agent: raw.agent ?? DEFAULTS.agent,
    mux: raw.mux ?? DEFAULTS.mux,
    git: { push: raw.git?.push ?? DEFAULTS.git.push, remote: raw.git?.remote ?? DEFAULTS.git.remote },
    approvalTimeoutMin: { ...DEFAULTS.approvalTimeoutMin, ...(raw.approval_timeout_min ?? {}) },
    permissionMode: { ...DEFAULTS.permissionMode, ...(raw.permission_mode ?? {}) },
    liveSessions: raw.live_sessions ?? DEFAULTS.liveSessions,
    contextLimit: raw.context_limit ?? DEFAULTS.contextLimit,
    schedules: lenientSchedules(raw.schedule),
  };
}

/** A bad [[schedule]] entry is skipped with a warning; it must not stop the desk from starting. */
function lenientSchedules(raw: unknown) {
  try {
    return parseSchedules(raw);
  } catch (e: any) {
    console.warn(`[schedule] ${e.message}`);
    if (!Array.isArray(raw)) return [];
    const ok: ReturnType<typeof parseSchedules> = [];
    for (const r of raw) {
      try {
        const [s] = parseSchedules([r]);
        if (!ok.some((o) => o.name === s.name)) ok.push(s);
      } catch { /* already warned */ }
    }
    return ok;
  }
}
