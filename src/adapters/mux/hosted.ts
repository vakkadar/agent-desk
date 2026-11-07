// Run agent turns inside a herdr pane so they survive agent-desk restarts (RH-2).
// Each turn: a bash script in the pane runs the agent with stdout -> out.jsonl and
// writes `exit` when done. We tail out.jsonl. After an agent-desk restart,
// recoverTurns() finds leftover turns and resumes tailing (skipping lines already
// consumed). If the process is gone without an exit file (host reboot, pane killed)
// the tail ends with exit code -1 => caller reports "interrupted"; the thread is
// resumable via `claude --resume <sessionId>` on the next prompt.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile, open, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrMux } from "./herdr.js";
import type { SpawnFn, SpawnedProc } from "./spawn.js";

export interface TurnMeta {
  id: string;
  key: string; // agent session id
  pane: string;
  cwd: string;
  consumed: number; // lines already yielded to the consumer
}

export const turnsDir = (dataDir: string) => join(dataDir, ".index", "turns");

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => stat(p).then(() => true, () => false);
const saveMeta = (dir: string, m: TurnMeta) => writeFile(join(dir, "meta.json"), JSON.stringify(m));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

/** Tail a turn directory until its exit file appears and output is drained. */
function tail(dir: string, meta: TurnMeta, skip: number, mux: HerdrMux): SpawnedProc {
  const exitFile = join(dir, "exit");
  let resolveExit!: (c: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  async function* lines(): AsyncGenerator<string> {
    let off = 0;
    let buf = "";
    let n = 0;
    for (;;) {
      const done = await exists(exitFile); // checked BEFORE reading so output is fully drained
      let chunk = "";
      try {
        const fh = await open(join(dir, "out.jsonl"), "r");
        const { size } = await fh.stat();
        if (size > off) {
          const b = Buffer.alloc(size - off);
          await fh.read(b, 0, b.length, off);
          off = size;
          chunk = b.toString("utf8");
        }
        await fh.close();
      } catch {}
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (n++ < skip) continue;
        meta.consumed = n;
        await saveMeta(dir, meta).catch(() => {});
        yield line;
      }
      if (done && !chunk) break;
      if (!done) {
        const pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
        if (pid && !alive(pid)) {
          await sleep(300); // let a racing exit file land
          if (!(await exists(exitFile))) await writeFile(exitFile, "-1");
          continue;
        }
        await sleep(100);
      }
    }
    const code = Number(await readFile(exitFile, "utf8").catch(() => "-1"));
    resolveExit(Number.isNaN(code) ? null : code);
  }
  return {
    lines: lines(),
    stderr: () => {
      try {
        return readFileSync(join(dir, "err.txt"), "utf8");
      } catch {
        return "";
      }
    },
    exited,
    kill: () => void mux.interrupt({ mux: "herdr", id: meta.pane }).catch(() => {}),
  };
}

export function hostedSpawn(mux: HerdrMux, dataDir: string): SpawnFn {
  return (bin, args, o) => {
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const dir = join(turnsDir(dataDir), id);
    const meta: TurnMeta = { id, key: o.key, pane: "", cwd: o.cwd, consumed: 0 };
    const started = (async () => {
      await mkdir(dir, { recursive: true });
      const pane = await mux.ensurePane(o.key, o.cwd);
      meta.pane = pane.id;
      await saveMeta(dir, meta);
      const script = [
        "#!/bin/bash",
        `echo $$ > ${q(join(dir, "pid"))}`,
        `cd ${q(o.cwd)} || exit 1`,
        // Pane shells don't inherit our env: pass the approval wait through to Claude.
        ...(process.env.MCP_TOOL_TIMEOUT ? [`export MCP_TOOL_TIMEOUT=${q(process.env.MCP_TOOL_TIMEOUT)}`] : []),
        `${[bin, ...args].map(q).join(" ")} < /dev/null > ${q(join(dir, "out.jsonl"))} 2> ${q(join(dir, "err.txt"))}`,
        `echo $? > ${q(join(dir, "exit.tmp"))} && mv ${q(join(dir, "exit.tmp"))} ${q(join(dir, "exit"))}`,
        "",
      ].join("\n");
      await writeFile(join(dir, "run.sh"), script);
      await mux.cli(["pane", "run", pane.id, `bash ${q(join(dir, "run.sh"))}`]);
    })();
    started.catch(() => {}); // surfaced through lines()
    let inner: SpawnedProc | undefined;
    let resolveExit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (resolveExit = r));
    async function* lines() {
      try {
        await started;
      } catch (e: any) {
        resolveExit(-1);
        throw e;
      }
      inner = tail(dir, meta, 0, mux);
      yield* inner.lines;
      resolveExit(await inner.exited);
      await rm(dir, { recursive: true, force: true });
    }
    return { lines: lines(), stderr: () => inner?.stderr() ?? "", exited, kill: () => inner?.kill() };
  };
}

export interface RecoveredTurn {
  meta: TurnMeta;
  proc: SpawnedProc; // remaining (unconsumed) lines; ends when the turn finishes
  cleanup(): Promise<void>; // delete turn files once delivered
}

/** Turns left by a previous agent-desk run: resume tailing them. */
export async function recoverTurns(mux: HerdrMux, dataDir: string): Promise<RecoveredTurn[]> {
  const root = turnsDir(dataDir);
  const out: RecoveredTurn[] = [];
  for (const id of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, id);
    try {
      const meta: TurnMeta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
      if (!meta.pane || !(await exists(join(dir, "run.sh")))) throw new Error("never launched");
      out.push({
        meta,
        proc: tail(dir, meta, meta.consumed, mux),
        cleanup: () => rm(dir, { recursive: true, force: true }),
      });
    } catch {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return out;
}
