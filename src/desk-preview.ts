// Desk perspective: preview a Desk thread before it is applied.
// Builds the thread's worktree and runs that build as a second desk on a spare port, with its own
// empty data folder (no projects, no herdr sessions of yours), so you can click through the change.
// Reachable on this host only (bound to 127.0.0.1). Stopped with the thread, or when the desk exits.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linkDeps, runCmd, type Run } from "./desk-apply.js";

export interface Preview { threadId: string; port: number; url: string; state: "building" | "starting" | "up" | "failed"; reason?: string }

export class DeskPreviews {
  private procs = new Map<string, { child?: ChildProcess; p: Preview }>();

  constructor(private dataDir: string, private repo: string, private basePort: number, private onChange?: (ps: Preview[]) => void, private run: Run = runCmd) {
    process.once("exit", () => this.stopAll());
  }

  list(): Preview[] { return [...this.procs.values()].map((x) => ({ ...x.p })); }

  private changed(): void { this.onChange?.(this.list()); }

  private freePort(): number {
    const used = new Set([...this.procs.values()].map((x) => x.p.port));
    for (let p = this.basePort; ; p++) if (!used.has(p)) return p;
  }

  async start(threadId: string, worktree: string): Promise<Preview> {
    this.stop(threadId);
    const port = this.freePort();
    const p: Preview = { threadId, port, url: `http://127.0.0.1:${port}/desk2.html`, state: "building" };
    const slot: { child?: ChildProcess; p: Preview } = { p };
    this.procs.set(threadId, slot);
    this.changed();
    linkDeps(this.repo, worktree);
    const b = await this.run(["npm", "run", "build"], worktree);
    if (this.procs.get(threadId) !== slot) return { ...p }; // stopped meanwhile
    if (b.code !== 0) return this.fail(slot, `build failed: ${b.out.trim().split("\n").slice(-3).join(" | ")}`);
    const data = join(this.dataDir, ".preview", threadId);
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "desk.toml"), `# preview of ${threadId}, made by the desk\nport = ${port}\nlive_sessions = []\nprofile = "admin"\n[network]\nbind = ["127.0.0.1"]\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DESK_DATA: data };
    delete env.AGENT_DESK_TOKEN; delete env.INVOCATION_ID;
    p.state = "starting";
    this.changed();
    const child = spawn(process.execPath, ["dist/server.js"], { cwd: worktree, env, stdio: ["ignore", "ignore", "pipe"] });
    slot.child = child;
    let err = "";
    child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("exit", (code) => { if (this.procs.get(threadId) === slot) this.fail(slot, `preview desk exited (${code}): ${err.trim().split("\n").slice(-2).join(" | ")}`); });
    for (let i = 0; i < 40 && p.state === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (ok && p.state === "starting") { p.state = "up"; this.changed(); }
    }
    if (p.state === "starting") { child.kill(); return this.fail(slot, "preview desk did not answer in 10 s"); }
    return { ...p };
  }

  private fail(slot: { p: Preview }, reason: string): Preview {
    Object.assign(slot.p, { state: "failed", reason });
    this.changed();
    return { ...slot.p };
  }

  stop(threadId: string): void {
    const x = this.procs.get(threadId);
    if (!x) return;
    this.procs.delete(threadId);
    x.child?.kill();
    this.changed();
  }

  stopAll(): void { for (const x of this.procs.values()) x.child?.kill(); this.procs.clear(); }
}
