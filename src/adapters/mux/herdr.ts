// herdr mux adapter: shells out to the `herdr` CLI (JSON responses).
// We never link herdr code (AGPL); process boundary only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentState, MuxAdapter, PaneRef } from "../../types.js";

const run = promisify(execFile);

async function herdr(args: string[]): Promise<any> {
  const { stdout } = await run("herdr", args, { timeout: 30_000 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

export class HerdrMux implements MuxAdapter {
  id = "herdr";

  async available(): Promise<boolean> {
    try {
      await run("herdr", ["status", "server"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  // TODO(M1): verify exact flags against `herdr pane` / `herdr agent` help on a
  // running server; response paths per `herdr --skill` (.result.root_pane etc).
  async spawn(name: string, cmd: string[], cwd: string): Promise<PaneRef> {
    const ws = await herdr(["workspace", "create", "--cwd", cwd]);
    const paneId: string = ws.result.root_pane.pane_id;
    await this.write({ mux: this.id, id: paneId }, cmd.join(" ") + "\n");
    return { mux: this.id, id: paneId, agentName: name };
  }

  async write(p: PaneRef, data: string): Promise<void> {
    await herdr(["pane", "send", p.id, data]);
  }

  async read(p: PaneRef): Promise<string> {
    const r = await herdr(["pane", "read", p.id]);
    return r?.result?.text ?? "";
  }

  async state(p: PaneRef): Promise<AgentState> {
    const r = await herdr(["agent", "list"]);
    const a = (r?.result?.agents ?? []).find((x: any) => x.pane_id === p.id);
    return (a?.state as AgentState) ?? "unknown";
  }

  async list(): Promise<PaneRef[]> {
    const r = await herdr(["pane", "list"]);
    return (r?.result?.panes ?? []).map((x: any) => ({ mux: this.id, id: x.pane_id }));
  }
}
