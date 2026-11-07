import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { CfAccessOpts } from "./net/cfaccess.js";

export interface DeskConfig {
  dataDir: string;
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
}

export const DEFAULTS: DeskConfig = {
  dataDir: join(homedir(), "agent-desk-data"),
  keyword: "browser",
  port: 7420,
  network: { bind: ["127.0.0.1"], actionAllow: ["127.0.0.1", "::1"], readonlyAllow: [] },
  agent: "claude",
  mux: "herdr",
  git: { push: false, remote: "origin" },
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
  };
}
