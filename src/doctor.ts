#!/usr/bin/env node
// `agent-desk doctor`: host readiness checks (RH-6). Pluggable via registerCheck().
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, type DeskConfig } from "./config.js";

export type Status = "PASS" | "WARN" | "FAIL";
export interface CheckResult { status: Status; msg: string }
export interface Ctx { cfg: DeskConfig; sh(cmd: string, args: string[], timeout?: number): Promise<{ ok: boolean; out: string }> }
export interface Check { name: string; os?: NodeJS.Platform; run(ctx: Ctx): Promise<CheckResult | CheckResult[]> } // os: only there

const checks: Check[] = [];
export function registerCheck(c: Check): void { checks.push(c); }

const sh: Ctx["sh"] = (cmd, args, timeout = 5000) =>
  new Promise((res) => execFile(cmd, args, { timeout }, (e, out, err) => res({ ok: !e, out: String(out || err || e?.message || "").trim() })));

const pass = (msg: string): CheckResult => ({ status: "PASS", msg });
const warn = (msg: string): CheckResult => ({ status: "WARN", msg });
const fail = (msg: string): CheckResult => ({ status: "FAIL", msg });

const MIN_FREE_GB = Number(process.env.AGENT_DESK_MIN_FREE_GB ?? 5);

registerCheck({
  name: "sleep targets masked",
  os: "linux",
  async run({ sh }) {
    const bad: string[] = [];
    for (const t of ["sleep", "suspend", "hibernate", "hybrid-sleep"]) {
      const r = await sh("systemctl", ["is-enabled", `${t}.target`]);
      if (!/masked/.test(r.out)) bad.push(t);
    }
    return bad.length ? fail(`not masked: ${bad.join(", ")} (sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target)`) : pass("sleep/suspend/hibernate masked");
  },
});

registerCheck({
  name: "bios power restore",
  os: "linux",
  async run() { return warn("cannot detect: verify BIOS 'Restore on AC power loss' = On"); },
});

registerCheck({
  name: "auto-updates",
  os: "linux",
  async run({ sh }) {
    const timers = await sh("systemctl", ["list-unit-files", "dnf5-automatic*.timer", "dnf-automatic*.timer", "--no-legend"]);
    const enabled = timers.out.split("\n").filter((l) => /\benabled\b/.test(l));
    if (!enabled.length) return pass("no dnf-automatic timer enabled");
    let reboot = "";
    for (const f of ["/etc/dnf/automatic.conf", "/etc/dnf/dnf5-plugins/automatic.conf"]) {
      if (existsSync(f)) {
        const r = await sh("grep", ["-E", "^\\s*reboot\\s*=", f]);
        if (r.ok) reboot = r.out;
      }
    }
    if (/=\s*(when-needed|when-changed|always)/.test(reboot)) return fail(`dnf-automatic auto-reboot on (${reboot}); set reboot = never or ensure clean boot`);
    return warn("dnf-automatic enabled, auto-reboot not detected as on; confirm host comes back cleanly after reboot");
  },
});

registerCheck({
  name: "tailscale",
  async run({ sh }) {
    const r = await sh("tailscale", ["status", "--json"], 8000);
    if (!r.ok) return fail("tailscale not available or not running");
    let j: any;
    try { j = JSON.parse(r.out); } catch { return fail("tailscale status unparsable"); }
    const out: CheckResult[] = [];
    out.push(j.BackendState === "Running" ? pass("tailscale up") : fail(`tailscale state ${j.BackendState}`));
    const exp = j.Self?.KeyExpiry;
    if (!exp) out.push(pass("tailscale key expiry disabled"));
    else {
      const days = (Date.parse(exp) - Date.now()) / 86400000;
      out.push(days < 0 ? fail("tailscale key expired") : days < 45 ? fail(`tailscale key expires in ${days.toFixed(0)}d; disable expiry in admin console`) : warn(`tailscale key expires in ${days.toFixed(0)}d; disable key expiry for this host`));
    }
    if (process.platform === "linux") {
      const en = await sh("systemctl", ["is-enabled", "tailscaled"]);
      out.push(/enabled/.test(en.out) ? pass("tailscaled enabled at boot") : warn("tailscaled not enabled at boot"));
    }
    return out;
  },
});

registerCheck({
  name: "claude auth",
  async run({ sh }) {
    const v = await sh("claude", ["--version"]);
    if (!v.ok) return fail("claude CLI not found");
    const r = await sh("claude", ["auth", "status"], 10000);
    try {
      const j = JSON.parse(r.out);
      return j.loggedIn ? pass(`claude logged in (${j.authMethod ?? "?"}); expiry not inspectable, verify 30+ days validity manually`) : fail("claude not logged in (run: claude auth login)");
    } catch { return warn("claude auth status unreadable: " + r.out.slice(0, 80)); }
  },
});

registerCheck({
  name: "herdr",
  async run({ sh }) {
    const v = await sh("herdr", ["--version"]);
    if (!v.ok && !existsSync(`${process.env.HOME}/.local/bin/herdr`)) return fail("herdr not found in PATH");
    const s = await sh("herdr", ["status", "server"]);
    return s.ok && /running/i.test(s.out) && !/not running/i.test(s.out) ? pass("herdr server running") : warn("herdr present but server not running");
  },
});

registerCheck({
  name: "linger",
  os: "linux",
  async run({ sh }) {
    const r = await sh("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger"]);
    return /Linger=yes/.test(r.out) ? pass("linger enabled") : fail("linger disabled (loginctl enable-linger)");
  },
});

registerCheck({
  name: "units",
  os: "linux",
  async run({ sh }) {
    const out: CheckResult[] = [];
    for (const u of ["herdr.service", "agent-desk.service"]) {
      const r = await sh("systemctl", ["--user", "is-enabled", u]);
      out.push(/^enabled/.test(r.out) ? pass(`${u} enabled`) : warn(`${u} not enabled (deploy/install.sh)`));
    }
    return out;
  },
});

// macOS: launchd agents instead of systemd units; pmset instead of masked sleep targets and the BIOS setting.
registerCheck({
  name: "sleep",
  os: "darwin",
  async run({ sh }) {
    const r = await sh("pmset", ["-g"]);
    const v = /^\s*sleep\s+(\d+)/m.exec(r.out)?.[1];
    return v === "0" ? pass("system sleep off") : fail(`system sleep ${v ?? "?"} min (sudo pmset -a sleep 0 disablesleep 1)`);
  },
});

registerCheck({
  name: "power restore",
  os: "darwin",
  async run({ sh }) {
    const r = await sh("pmset", ["-g"]);
    const v = /^\s*autorestart\s+(\d+)/m.exec(r.out)?.[1];
    if (v === undefined) return warn("autorestart not reported: check System Settings > Energy > Start up automatically after a power failure");
    return v === "1" ? pass("starts up after a power failure") : fail("autorestart off (sudo pmset -a autorestart 1)");
  },
});

registerCheck({
  name: "launchd agents",
  os: "darwin",
  async run({ sh }) {
    const out: CheckResult[] = [];
    const uid = process.getuid?.() ?? 501;
    for (const l of ["com.agent-desk.herdr", "com.agent-desk.server"]) {
      const r = await sh("launchctl", ["print", `gui/${uid}/${l}`]);
      out.push(!r.ok ? warn(`${l} not loaded (deploy/install.sh)`) : /state = running/.test(r.out) ? pass(`${l} running`) : warn(`${l} loaded, not running`));
    }
    const al = await sh("defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]);
    out.push(al.ok && al.out === process.env.USER ? pass("automatic login on: agents come back after a restart") : warn("automatic login off: after a restart the agents wait for someone to log in (System Settings > Users & Groups)"));
    return out;
  },
});

registerCheck({
  name: "disk",
  async run({ cfg }) {
    try {
      const s = await statfs(cfg.dataDir);
      const gb = (s.bavail * s.bsize) / 1024 ** 3;
      return gb >= MIN_FREE_GB ? pass(`${gb.toFixed(1)} GB free at ${cfg.dataDir}`) : fail(`only ${gb.toFixed(1)} GB free at ${cfg.dataDir} (< ${MIN_FREE_GB})`);
    } catch { return warn(`data dir ${cfg.dataDir} missing; cannot check disk`); }
  },
});

registerCheck({
  name: "data repo remote",
  async run({ cfg, sh }) {
    if (!existsSync(`${cfg.dataDir}/.git`)) return warn("data dir is not a git repo; no off-site backup");
    const url = await sh("git", ["-C", cfg.dataDir, "remote", "get-url", "origin"]);
    if (!url.ok) return warn("data repo has no origin remote (RH-8 backup recommended)");
    const r = await sh("git", ["-C", cfg.dataDir, "ls-remote", "--exit-code", "origin", "HEAD"], 15000);
    return r.ok ? pass("data repo remote reachable") : fail("data repo remote unreachable: " + r.out.slice(0, 100));
  },
});

registerCheck({
  name: "token",
  async run({ cfg }) {
    const t = cfg.network.actionToken;
    if (!t) return fail("AGENT_DESK_TOKEN not set (action role needs a token)");
    return t.length < 16 ? warn("token shorter than 16 chars") : pass("token set");
  },
});

registerCheck({
  name: "bind",
  async run({ cfg }) {
    const wide = cfg.network.bind.filter((b) => b === "0.0.0.0" || b === "::");
    if (wide.length) return warn(`binding ${wide.join(", ")} exposes all interfaces; prefer 127.0.0.1 or the tailnet IP`);
    return pass(`bind ${cfg.network.bind.join(", ")}`);
  },
});

export async function runDoctor(cfg?: DeskConfig, log: (s: string) => void = console.log): Promise<number> {
  cfg ??= await loadConfig();
  const ctx: Ctx = { cfg, sh };
  let fails = 0, warns = 0;
  for (const c of checks) {
    if (c.os && c.os !== process.platform) continue;
    let rs: CheckResult[];
    try { const r = await c.run(ctx); rs = Array.isArray(r) ? r : [r]; } catch (e: any) { rs = [fail(`check crashed: ${e?.message ?? e}`)]; }
    for (const r of rs) {
      if (r.status === "FAIL") fails++;
      if (r.status === "WARN") warns++;
      log(`${r.status}  ${c.name}: ${r.msg}`);
    }
  }
  log(`\n${fails} fail, ${warns} warn`);
  return fails ? 1 : 0;
}

// The service gets its env from ~/.config/agent-desk/env (systemd EnvironmentFile; on macOS the launchd job sources it). Doctor run by hand
// from a shell doesn't, so load the same file. Vars already set in the shell win.
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || env[m[1]] !== undefined) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  loadEnvFile(`${process.env.HOME}/.config/agent-desk/env`);
  process.exit(await runDoctor());
}
