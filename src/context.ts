// How full a Claude session's context is, read from the last assistant turn's usage
// in its transcript. Used to suggest /compact before the session runs out of room.
import { open } from "node:fs/promises";
import { join } from "node:path";
import { projectDir } from "./claude-sessions.js";

/** Tokens in context after the last assistant reply, or undefined if unknown. */
export async function contextUsed(cwd: string, sessionId: string, root?: string): Promise<number | undefined> {
  const fh = await open(join(projectDir(cwd, root), `${sessionId}.jsonl`), "r").catch(() => null);
  if (!fh) return undefined;
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; } // torn first line
      if (m.type !== "assistant" || m.isSidechain) continue;
      const u = m.message?.usage;
      if (!u) continue;
      return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    return undefined;
  } finally {
    await fh.close();
  }
}
