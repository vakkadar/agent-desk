// Process-spawn abstraction so agent adapters can run turns directly ("none")
// or inside a mux pane (herdr) without knowing the difference.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface SpawnedProc {
  lines: AsyncIterable<string>; // stdout lines
  stderr(): string; // stderr collected so far
  exited: Promise<number | null>;
  kill(): void;
}

export interface SpawnOpts {
  cwd: string;
  key: string; // stable id for the conversation (agent session id); used for pane reuse + recovery
}

export type SpawnFn = (bin: string, args: string[], o: SpawnOpts) => SpawnedProc;

export const directSpawn: SpawnFn = (bin, args, o) => {
  const child = spawn(bin, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  return {
    lines: createInterface({ input: child.stdout }),
    stderr: () => err,
    exited: new Promise((r) => child.on("close", r)),
    kill: () => child.kill("SIGTERM"),
  };
};
