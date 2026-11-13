// Sources and threads, persisted as sources/<id>/source.json in the data repo.
// The stored session ids are what lets threads resume after a reboot (RH-2).
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Mode, SessionRef } from "./types.js";

export interface ThreadRec {
  id: string; // "ask" | "design-N" | "code-N"
  mode: Mode;
  session: SessionRef;
  createdAt: string;
  title?: string; // General questions: first prompt, for the list and `c:` matching
  closed?: string; // ISO time it was closed: folded away in the list; sending to it reopens it
  worktree?: string; // code threads in a git project: their own git worktree (agents run there)
  branch?: string; // that worktree's branch, e.g. desk/code-1
  base?: string; // commit the thread started from (diff base)
  from?: string; // thread it was started from (design-1 -> code-2): a related link
}

export interface SourceRec {
  id: string;
  kind: "local" | "git" | "url";
  location: string;
  agent: string;
  threads: Record<string, ThreadRec>; // "ask" is the base session
  builtin?: boolean; // General: created by the desk, not attached by the user
  herdrSession?: string; // opened from a named herdr session (herdr-sessions.ts): prompts go to its Claude window
}

export class ThreadStore {
  private sources = new Map<string, SourceRec>();
  constructor(private dataDir: string) {}

  private dir(id: string) {
    return join(this.dataDir, "sources", id);
  }

  async load(): Promise<void> {
    const root = join(this.dataDir, "sources");
    await mkdir(root, { recursive: true });
    for (const id of await readdir(root)) {
      try {
        const rec = JSON.parse(await readFile(join(root, id, "source.json"), "utf8")) as SourceRec;
        this.sources.set(rec.id, rec);
      } catch (e: any) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      }
    }
  }

  list(): SourceRec[] {
    return [...this.sources.values()];
  }

  get(id: string): SourceRec | undefined {
    return this.sources.get(id);
  }

  async save(rec: SourceRec): Promise<void> {
    this.sources.set(rec.id, rec);
    await mkdir(this.dir(rec.id), { recursive: true });
    const file = join(this.dir(rec.id), "source.json");
    await writeFile(file + ".tmp", JSON.stringify(rec, null, 2) + "\n");
    await rename(file + ".tmp", file); // atomic replace
  }

  /** Next free thread id for a mode: design-1, design-2, ... */
  nextThreadId(rec: SourceRec, mode: Exclude<Mode, "ask">): string {
    let n = 1;
    while (rec.threads[`${mode}-${n}`]) n++;
    return `${mode}-${n}`;
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "source";
}

export function sourceKind(location: string): SourceRec["kind"] {
  if (/^https?:\/\//.test(location)) return /\.git$|github\.com|gitlab\.com/.test(location) ? "git" : "url";
  return "local";
}
