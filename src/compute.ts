// Compute perspective: the machines and hosting accounts the desk can see and switch on/off.
//
// <data>/compute.toml lists machines (no secrets in it):
//
//   [[machine]]
//   id = "hp"                      # unique
//   label = "HP desktop"
//   group = "Home"                 # optional: machines with the same group sit together (iMac: mac + linux)
//   os = "linux"                   # linux | macos | windows | ios | vps | domains
//   tailscale = "hp"               # tailnet host name: online, last seen, IP
//   ssh = "vakkadar@hp"            # optional: Uptime/Disk/Reboot/Shut down over ssh (BatchMode, keys only)
//   ha_power = "switch.hp_desktop" # optional: Home Assistant entity that powers it on/off
//   wake_mac = "aa:bb:cc:dd:ee:ff" # optional: Wake-on-LAN from the desk's host (same LAN only)
//   hostinger_vm = 1330230         # optional: Hostinger VPS id: state, start/stop/restart, API menu
//   godaddy = true                 # optional: GoDaddy API menu (domains, DNS)
//   [[machine.action]]             # optional extra ssh commands
//   label = "Boot macOS next"
//   run = "sudo -n efibootmgr --bootnext 0080 && sudo -n systemctl reboot"
//   confirm = true
//
// Secrets live in ~/.config/agent-desk/secrets.toml (mode 0600, never in git, never sent to a browser):
//
//   [home_assistant]
//   url = "http://homeassistant.local:8123"
//   token = "<long-lived access token>"
//   [hostinger]
//   token = "<API token from hPanel → Account → API>"
//   [godaddy]
//   key = "<key>"
//   secret = "<secret>"
//
// The browser only names a machine and an action id; every command and URL is fixed here.
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { redact } from "./secrets.js";

export type Os = "linux" | "macos" | "windows" | "ios" | "vps" | "domains";

export interface Machine {
  id: string;
  label: string;
  group?: string;
  os: Os;
  tailscale?: string;
  ssh?: string;
  haPower?: string;
  wakeMac?: string;
  hostingerVm?: number;
  godaddy?: boolean;
  actions: { label: string; run: string; confirm: boolean }[];
}

export interface Secrets {
  home_assistant?: { url?: string; token?: string };
  hostinger?: { token?: string };
  godaddy?: { key?: string; secret?: string };
}

/** One menu entry for a machine. `confirm`: the page asks twice (it powers off, restarts, …). */
export interface ComputeAction { id: string; label: string; group: "power" | "ssh" | "api"; confirm?: boolean; param?: string }

export interface MachineState {
  id: string;
  label: string;
  group?: string;
  os: Os;
  online?: boolean; // tailnet
  lastSeen?: string;
  ip?: string;
  power?: string; // Home Assistant entity state, or the Hostinger VM state
  note?: string; // what is missing to make it useful (secrets, config)
  actions: ComputeAction[];
}

export const SECRETS_FILE = process.env.AGENT_DESK_SECRETS ?? join(homedir(), ".config", "agent-desk", "secrets.toml");
const OSES: Os[] = ["linux", "macos", "windows", "ios", "vps", "domains"];

export function parseMachines(text: string): Machine[] {
  const raw: any = parse(text);
  const list: any[] = Array.isArray(raw.machine) ? raw.machine : [];
  const seen = new Set<string>();
  return list.map((m, i) => {
    const where = `compute.toml machine #${i + 1}`;
    const id = String(m.id ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`${where}: id must be letters, digits, - or _`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);
    const os = String(m.os ?? "linux") as Os;
    if (!OSES.includes(os)) throw new Error(`${where}: os must be one of ${OSES.join(", ")}`);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const wakeMac = str(m.wake_mac);
    if (wakeMac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(wakeMac)) throw new Error(`${where}: wake_mac must look like aa:bb:cc:dd:ee:ff`);
    return {
      id, os, label: str(m.label) ?? id, group: str(m.group), tailscale: str(m.tailscale), ssh: str(m.ssh), haPower: str(m.ha_power), wakeMac,
      hostingerVm: m.hostinger_vm != null ? Number(m.hostinger_vm) : undefined, godaddy: m.godaddy === true,
      actions: (Array.isArray(m.action) ? m.action : []).filter((a: any) => str(a?.label) && str(a?.run)).map((a: any) => ({ label: str(a.label)!, run: str(a.run)!, confirm: a.confirm === true })),
    };
  });
}

/** Secrets file; refused when other users can read it. */
export function loadSecrets(file = SECRETS_FILE): Secrets {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return {}; }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077)) throw new Error(`${file} is readable by others: chmod 600 it`);
  return parse(text) as Secrets;
}

// ---------- what each machine offers ----------
const SSH_ACTIONS: Record<string, ComputeAction & { run: Record<string, string> }> = {
  uptime: { id: "ssh:uptime", label: "Uptime", group: "ssh", run: { linux: "uptime", macos: "uptime", windows: 'powershell -NoProfile -c "(Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime | Select Days,Hours,Minutes | Format-List"' } },
  disk: { id: "ssh:disk", label: "Disk", group: "ssh", run: { linux: "df -h -x tmpfs -x devtmpfs -x squashfs", macos: "df -h /", windows: 'powershell -NoProfile -c "Get-PSDrive -PSProvider FileSystem | Format-Table Name,Used,Free"' } },
  reboot: { id: "ssh:reboot", label: "Reboot", group: "ssh", confirm: true, run: { linux: "sudo -n systemctl reboot", macos: "sudo -n shutdown -r now", windows: "shutdown /r /t 5" } },
  poweroff: { id: "ssh:poweroff", label: "Shut down", group: "ssh", confirm: true, run: { linux: "sudo -n systemctl poweroff", macos: "sudo -n shutdown -h now", windows: "shutdown /s /t 5" } },
};

const HOSTINGER = "https://developers.hostinger.com";
const HOSTINGER_MENU: { id: string; label: string; path: (vm: number, p: string) => string; param?: string }[] = [
  { id: "vms", label: "Virtual machines", path: () => "/api/vps/v1/virtual-machines" },
  { id: "vm", label: "This VPS", path: (vm) => `/api/vps/v1/virtual-machines/${vm}` },
  { id: "metrics", label: "Metrics (24 h)", path: (vm) => { const to = new Date(), from = new Date(to.getTime() - 86_400_000); return `/api/vps/v1/virtual-machines/${vm}/metrics?date_from=${from.toISOString()}&date_to=${to.toISOString()}`; } },
  { id: "actions", label: "Action log", path: (vm) => `/api/vps/v1/virtual-machines/${vm}/actions` },
  { id: "backups", label: "Backups", path: (vm) => `/api/vps/v1/virtual-machines/${vm}/backups` },
  { id: "domains", label: "Domains", path: () => "/api/domains/v1/portfolio" },
  { id: "dns", label: "DNS zone", param: "domain", path: (_vm, d) => `/api/dns/v1/zones/${encodeURIComponent(d)}` },
  { id: "billing", label: "Subscriptions", path: () => "/api/billing/v1/subscriptions" },
];
const GODADDY = "https://api.godaddy.com";
const GODADDY_MENU: { id: string; label: string; path: (p: string) => string; param?: string }[] = [
  { id: "domains", label: "Domains", path: () => "/v1/domains?limit=500" },
  { id: "domain", label: "Domain details", param: "domain", path: (d) => `/v1/domains/${encodeURIComponent(d)}` },
  { id: "dns", label: "DNS records", param: "domain", path: (d) => `/v1/domains/${encodeURIComponent(d)}/records` },
];

export function actionsOf(m: Machine): ComputeAction[] {
  const a: ComputeAction[] = [];
  if (m.haPower) a.push({ id: "ha:on", label: "Power on", group: "power" }, { id: "ha:off", label: "Power off", group: "power", confirm: true });
  if (m.wakeMac) a.push({ id: "wol", label: "Wake (LAN)", group: "power" });
  if (m.hostingerVm != null) a.push({ id: "vps:start", label: "Start VPS", group: "power" }, { id: "vps:restart", label: "Restart VPS", group: "power", confirm: true }, { id: "vps:stop", label: "Stop VPS", group: "power", confirm: true });
  if (m.ssh && SSH_ACTIONS.uptime.run[m.os]) for (const s of Object.values(SSH_ACTIONS)) a.push({ id: s.id, label: s.label, group: "ssh", confirm: s.confirm });
  if (m.ssh) m.actions.forEach((x, i) => a.push({ id: `cmd:${i}`, label: x.label, group: "ssh", confirm: x.confirm }));
  if (m.hostingerVm != null) for (const h of HOSTINGER_MENU) a.push({ id: `hostinger:${h.id}`, label: h.label, group: "api", param: h.param });
  if (m.godaddy) for (const g of GODADDY_MENU) a.push({ id: `godaddy:${g.id}`, label: g.label, group: "api", param: g.param });
  return a;
}

// ---------- doing it ----------
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

const execCmd: Exec = (cmd, args) =>
  new Promise((res) => execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 << 20 }, (err, out, errout) =>
    res({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, out: String(out) + String(errout) })));

export interface ComputeDeps { fetch?: Fetch; exec?: Exec; secrets?: () => Secrets; machines?: () => Machine[] }

export interface ComputeResult { type: "compute_out"; id: string; action: string; label: string; ok: boolean; out: string; at: string }

const MAX_OUT = 20_000;
const clip = (s: string) => redact(s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n… (cut)" : s).text;

/** The Compute chat: a built-in source (admin only) with one Claude thread per machine. */
export const COMPUTE_ID = "compute";

/**
 * CLAUDE.md for the Compute chat's folder: what each machine is and how to reach it. Claude reads
 * it at the start of every session there; prompts arrive as `compute[<machine id>]: <text>`.
 */
export function computeBrief(ms: Machine[]): string {
  const row = (m: Machine) => [
    `- **${m.id}** (${m.label}, ${m.os}${m.group ? ", " + m.group : ""})`,
    m.ssh ? `ssh \`${m.ssh}\`` : "no ssh",
    m.tailscale ? `tailnet name \`${m.tailscale}\`` : "",
    m.haPower ? `power via Home Assistant entity \`${m.haPower}\` (Compute menu)` : "",
    m.hostingerVm ? `Hostinger VPS ${m.hostingerVm} (Compute menu)` : "",
    m.godaddy ? "GoDaddy domains account (Compute menu)" : "",
  ].filter(Boolean).join(" · ");
  return `# Compute chat

You help run the machines below from the agent desk's Compute perspective. Each prompt starts
with \`compute[<machine id>]:\`: that is the machine the person is looking at. \`compute[all]:\`
means no machine in particular.

## Rules
- Reach machines with \`ssh -o BatchMode=yes -o ConnectTimeout=8 <target> '<command>'\`. Read-only
  checks (uptime, disk, logs, services, updates available) are fine; say what you ran.
- Ask in chat before anything that changes a machine: reboot, shutdown, installs, upgrades, deleting,
  editing config, restarting services. Prefer the Compute menu buttons for power.
- Never print, copy or read secrets (\`~/.config/agent-desk/secrets.toml\`, \`.env\` files, tokens, keys).
- Keep answers short: what you found, what you suggest.

## Machines (from compute.toml)
${ms.map(row).join("\n") || "(none configured)"}
`;
}

export class Compute {
  private fetch: Fetch;
  private exec: Exec;
  private secrets: () => Secrets;
  /** compute.toml, read fresh on every call (throws on a bad file). */
  readonly machines: () => Machine[];

  constructor(dataDir: string, deps: ComputeDeps = {}) {
    this.fetch = deps.fetch ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(20_000) }));
    this.exec = deps.exec ?? execCmd;
    this.secrets = deps.secrets ?? (() => loadSecrets());
    this.machines = deps.machines ?? (() => { try { return parseMachines(readFileSync(join(dataDir, "compute.toml"), "utf8")); } catch (e: any) { if (e?.code === "ENOENT") return []; throw e; } });
  }

  /** Every machine with tailnet presence and power state (best effort: a failing source leaves a note). */
  async state(): Promise<{ type: "compute"; machines: MachineState[]; error?: string }> {
    let ms: Machine[];
    try { ms = this.machines(); } catch (e: any) { return { type: "compute", machines: [], error: String(e?.message ?? e) }; }
    let sec: Secrets = {};
    let secErr = "";
    try { sec = this.secrets(); } catch (e: any) { secErr = String(e?.message ?? e); }
    const ts = ms.some((m) => m.tailscale) ? await this.tailnet() : new Map<string, any>();
    return {
      type: "compute",
      machines: await Promise.all(ms.map(async (m) => {
        const s: MachineState = { id: m.id, label: m.label, group: m.group, os: m.os, actions: actionsOf(m) };
        const notes: string[] = secErr ? [secErr] : [];
        if (m.tailscale) {
          const p = ts.get(m.tailscale.toLowerCase());
          if (p) Object.assign(s, { online: !!p.Online, lastSeen: p.Online ? undefined : p.LastSeen, ip: p.TailscaleIPs?.[0] });
          else notes.push(`${m.tailscale} is not on the tailnet`);
        }
        if (m.haPower) {
          if (!sec.home_assistant?.url || !sec.home_assistant.token) notes.push("Home Assistant url/token missing in secrets.toml");
          else s.power = await this.haState(sec, m.haPower).catch((e) => (notes.push(`Home Assistant: ${e.message}`), undefined));
        }
        if (m.hostingerVm != null) {
          if (!sec.hostinger?.token) notes.push("Hostinger token missing in secrets.toml");
          else s.power = await this.hostinger(sec, `/api/vps/v1/virtual-machines/${m.hostingerVm}`).then((j: any) => j?.state, (e) => (notes.push(`Hostinger: ${e.message}`), undefined));
        }
        if (m.godaddy && (!sec.godaddy?.key || !sec.godaddy.secret)) notes.push("GoDaddy key/secret missing in secrets.toml");
        if (notes.length) s.note = notes.join("; ");
        return s;
      })),
    };
  }

  /** Run one menu entry. Never throws: failures come back as ok=false with the reason. */
  async run(id: string, action: string, param = ""): Promise<ComputeResult> {
    const m = this.machines().find((x) => x.id === id);
    const a = m && actionsOf(m).find((x) => x.id === action);
    const res = (ok: boolean, out: string): ComputeResult => ({ type: "compute_out", id, action, label: a?.label ?? action, ok, out: clip(out), at: new Date().toISOString() });
    if (!m || !a) return res(false, `${id} has no action ${action}`);
    if (a.param && !/^[a-z0-9.-]{1,253}$/i.test(param)) return res(false, `${a.label} needs a ${a.param} (letters, digits, dots)`);
    try {
      const sec = action.startsWith("ssh:") || action.startsWith("cmd:") || action === "wol" ? {} : this.secrets();
      const [kind, sub] = action.split(":");
      switch (kind) {
        case "ha": {
          const domain = m.haPower!.split(".")[0];
          const svc = domain === "button" ? "press" : sub === "on" ? "turn_on" : "turn_off";
          if (domain === "button" && sub === "off") return res(false, "a button entity cannot turn off; use a switch or script");
          await this.ha(sec, `/api/services/${domain}/${svc}`, { entity_id: m.haPower });
          return res(true, `${m.haPower}: ${svc} sent`);
        }
        case "wol": await wake(m.wakeMac!); return res(true, `magic packet sent to ${m.wakeMac}`);
        case "vps": {
          const j = await this.hostinger(sec, `/api/vps/v1/virtual-machines/${m.hostingerVm}/${sub}`, "POST");
          return res(true, JSON.stringify(j, null, 2));
        }
        case "hostinger": {
          const h = HOSTINGER_MENU.find((x) => x.id === sub)!;
          return res(true, JSON.stringify(await this.hostinger(sec, h.path(m.hostingerVm!, param)), null, 2));
        }
        case "godaddy": {
          const g = GODADDY_MENU.find((x) => x.id === sub)!;
          return res(true, JSON.stringify(await this.godaddy(sec, g.path(param)), null, 2));
        }
        case "ssh":
        case "cmd": {
          const cmd = kind === "cmd" ? m.actions[Number(sub)].run : Object.values(SSH_ACTIONS).find((x) => x.id === action)!.run[m.os];
          const r = await this.exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", m.ssh!, cmd]);
          // A reboot/shutdown often drops the connection before ssh can report success.
          const dropped = !!a.confirm && r.code === 255 && /closed|reset|broken pipe/i.test(r.out);
          return res(r.code === 0 || dropped, r.out.trim() || (r.code === 0 || dropped ? "done" : `ssh exited ${r.code}`));
        }
      }
      return res(false, `unknown action ${action}`);
    } catch (e: any) {
      return res(false, String(e?.message ?? e));
    }
  }

  private async tailnet(): Promise<Map<string, any>> {
    const r = await this.exec("tailscale", ["status", "--json"]);
    const map = new Map<string, any>();
    if (r.code !== 0) return map;
    try {
      const j = JSON.parse(r.out);
      for (const p of [j.Self, ...Object.values(j.Peer ?? {})] as any[]) {
        if (!p) continue;
        if (p.HostName) map.set(String(p.HostName).toLowerCase(), p);
        if (p.DNSName) map.set(String(p.DNSName).split(".")[0].toLowerCase(), p);
      }
    } catch {}
    return map;
  }

  private async call(url: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<unknown> {
    const r = await this.fetch(url, { method, headers: { accept: "application/json", ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return text; }
  }
  private ha(sec: Secrets, path: string, body?: unknown) {
    const h = sec.home_assistant;
    if (!h?.url || !h.token) throw new Error("Home Assistant url/token missing in secrets.toml");
    return this.call(h.url.replace(/\/+$/, "") + path, { authorization: `Bearer ${h.token}` }, body ? "POST" : "GET", body);
  }
  private async haState(sec: Secrets, entity: string): Promise<string> {
    return String(((await this.ha(sec, `/api/states/${entity}`)) as any)?.state ?? "unknown");
  }
  private hostinger(sec: Secrets, path: string, method = "GET") {
    if (!sec.hostinger?.token) throw new Error("Hostinger token missing in secrets.toml");
    return this.call(HOSTINGER + path, { authorization: `Bearer ${sec.hostinger.token}` }, method);
  }
  private godaddy(sec: Secrets, path: string) {
    const g = sec.godaddy;
    if (!g?.key || !g.secret) throw new Error("GoDaddy key/secret missing in secrets.toml");
    return this.call(GODADDY + path, { authorization: `sso-key ${g.key}:${g.secret}` });
  }
}

/** Wake-on-LAN magic packet, broadcast on the desk host's LAN. */
export function magicPacket(mac: string): Buffer {
  const hw = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(hw)]);
}
function wake(mac: string): Promise<void> {
  return new Promise((res, rej) => {
    const s = createSocket("udp4");
    s.once("error", (e) => { s.close(); rej(e); });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(magicPacket(mac), 9, "255.255.255.255", (e) => { s.close(); e ? rej(e) : res(); });
    });
  });
}
