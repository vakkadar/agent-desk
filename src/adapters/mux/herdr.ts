// herdr mux adapter: shells out to the `herdr` CLI. We never link herdr code
// (AGPL); process boundary only. Verified against herdr 0.9.1.
// All calls use a dedicated named session (default "agent-desk") so we never
// touch the user's default herdr session. Raw TUI attach for recovery (RH-5):
//   herdr --session agent-desk            (local)
//   herdr --remote <host> --session agent-desk
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AgentState, MuxAdapter, PaneRef } from "../../types.js";

const run = promisify(execFile);

export class HerdrMux implements MuxAdapter {
  id = "herdr";
  /** @param panesFile JSON map key -> pane id, so a restarted agent-desk reuses panes. */
  constructor(
    public session = "agent-desk",
    private panesFile?: string,
    private bin = "herdr",
  ) {}

  private base(): string[] {
    return ["--session", this.session];
  }

  /** Run a herdr CLI command; parses JSON if the output is JSON, else returns raw text. */
  async cli(args: string[], timeout = 30_000): Promise<any> {
    const { stdout } = await run(this.bin, [...this.base(), ...args], { timeout });
    const t = stdout.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  async available(): Promise<boolean> {
    try {
      // exits 0 even when down; must parse the "status: running" line
      const { stdout } = await run(this.bin, [...this.base(), "status", "server"], { timeout: 5_000 });
      return /^status:\s*running/m.test(stdout);
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const { stdout } = await run(this.bin, ["--version"], { timeout: 5_000 });
    return stdout.trim();
  }

  /** Start the headless server for our session if it is not running. */
  async ensureServer(): Promise<void> {
    if (await this.available()) return;
    const child = spawn(this.bin, [...this.base(), "server"], { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.available()) return;
    }
    throw new Error("herdr server did not start");
  }

  private async loadPanes(): Promise<Record<string, string>> {
    if (!this.panesFile) return {};
    try {
      return JSON.parse(await readFile(this.panesFile, "utf8"));
    } catch {
      return {};
    }
  }

  /** Pane for a conversation key: reuse the stored one if still alive, else create a workspace. */
  async ensurePane(key: string, cwd: string): Promise<PaneRef & { fresh?: boolean }> {
    await this.ensureServer();
    const map = await this.loadPanes();
    const live = new Set((await this.list()).map((p) => p.id));
    if (map[key] && live.has(map[key])) return { mux: this.id, id: map[key] };
    const ws = await this.cli(["workspace", "create", "--cwd", cwd, "--no-focus"]);
    const id: string = ws.result.root_pane.pane_id;
    if (this.panesFile) {
      map[key] = id;
      await mkdir(dirname(this.panesFile), { recursive: true });
      await writeFile(this.panesFile, JSON.stringify(map, null, 1));
    }
    return { mux: this.id, id, fresh: true };
  }

  async spawn(name: string, cmd: string[], cwd: string): Promise<PaneRef> {
    const p = await this.ensurePane(name, cwd);
    await this.cli(["pane", "run", p.id, cmd.join(" ")]);
    return { ...p, agentName: name };
  }

  async write(p: PaneRef, data: string): Promise<void> {
    await this.cli(["pane", "send-text", p.id, data]);
  }

  async interrupt(p: PaneRef): Promise<void> {
    await this.cli(["pane", "send-keys", p.id, "ctrl+c"]);
  }

  async read(p: PaneRef): Promise<string> {
    const r = await this.cli(["pane", "read", p.id, "--source", "recent-unwrapped", "--lines", "200"]);
    return typeof r === "string" ? r : (r?.result?.text ?? "");
  }

  async state(p: PaneRef): Promise<AgentState> {
    const r = await this.cli(["agent", "list"]);
    const a = (r?.result?.agents ?? []).find((x: any) => x.pane_id === p.id);
    return (a?.state as AgentState) ?? "unknown";
  }

  async list(): Promise<PaneRef[]> {
    const r = await this.cli(["pane", "list"]);
    return (r?.result?.panes ?? []).map((x: any) => ({ mux: this.id, id: x.pane_id }));
  }

  async close(p: PaneRef): Promise<void> {
    await this.cli(["pane", "close", p.id]);
  }
}
