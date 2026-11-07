// Desk data repo: auto-commit after turns, secret scan, opt-in push (FR-19, FR-21, FR-22, RH-8).
import { execFile } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "./secrets.js";

export interface GitConfig { push: boolean; remote: string }
export interface GitStatus { lastCommit: string | null; lastPush: string | null; lastPushOk: boolean | null; pending: boolean }

const TEXT_EXT = /\.(jsonl?|md|txt|toml|log)$/;

export class DeskGit {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();
  private st: GitStatus = { lastCommit: null, lastPush: null, lastPushOk: null, pending: false };
  private reasons: string[] = [];
  onFlag: (hits: string[], files: string[]) => void = () => {};
  onCommit: (hash: string, msg: string) => void = () => {};

  constructor(private dir: string, private cfg: GitConfig, private debounceMs = 10_000) {}

  status(): GitStatus { return { ...this.st }; }

  private git(...args: string[]): Promise<string> {
    return new Promise((res, rej) =>
      execFile("git", args, { cwd: this.dir, maxBuffer: 16 << 20 }, (err, out, errout) =>
        err ? rej(new Error(`git ${args[0]}: ${errout || err.message}`.trim())) : res(out)));
  }

  async init(): Promise<void> {
    const exists = await access(join(this.dir, ".git")).then(() => true, () => false);
    if (!exists) await this.git("init", "-q");
    const gi = join(this.dir, ".gitignore");
    const cur = await readFile(gi, "utf8").catch(() => "");
    if (!cur.includes(".index/")) await writeFile(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + ".index/\n");
    this.st.pending = (await this.git("status", "--porcelain")).trim().length > 0;
  }

  /** Schedule a debounced commit (call after each completed turn). */
  schedule(reason: string): void {
    this.reasons.push(reason);
    this.st.pending = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.commitNow(); }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Commit immediately (also used on shutdown / tests). Serialized. */
  commitNow(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.running = this.running.then(() => this.doCommit()).catch((e) => console.error("[git]", e.message));
    return this.running;
  }

  private async doCommit(): Promise<void> {
    const porcelain = (await this.git("status", "--porcelain", "-uall")).split("\n").filter(Boolean);
    if (!porcelain.length) { this.st.pending = false; this.reasons = []; return; }
    const files = porcelain.map((l) => l.slice(3).replace(/^"|"$/g, ""));
    const flagged: string[] = [];
    const allHits = new Set<string>();
    for (const f of files) {
      if (!TEXT_EXT.test(f)) continue;
      const p = join(this.dir, f);
      let text: string;
      try { text = await readFile(p, "utf8"); } catch { continue; }
      const r = redact(text);
      if (r.hits.length) {
        await writeFile(p, r.text);
        flagged.push(f);
        r.hits.forEach((h) => allHits.add(h));
      }
    }
    if (flagged.length) this.onFlag([...allHits], flagged);
    await this.git("add", "-A");
    const uniq = [...new Set(this.reasons)];
    const msg = `Notes: ${uniq.length ? uniq.slice(0, 5).join("; ") : "update"}${uniq.length > 5 ? ` (+${uniq.length - 5} more)` : ""}` +
      `\n\n${files.length} file(s) changed${flagged.length ? `; secrets redacted in ${flagged.join(", ")}` : ""}`;
    this.reasons = [];
    await this.git("-c", "user.name=agent-desk", "-c", "user.email=agent-desk@localhost", "commit", "-q", "-m", msg);
    const hash = (await this.git("rev-parse", "--short", "HEAD")).trim();
    this.st.lastCommit = new Date().toISOString();
    this.st.pending = false;
    this.onCommit(hash, msg.split("\n")[0]);
    if (this.cfg.push) await this.push();
  }

  async push(): Promise<void> {
    this.st.lastPush = new Date().toISOString();
    try {
      await this.git("push", "-q", this.cfg.remote, "HEAD");
      this.st.lastPushOk = true;
    } catch (e: any) {
      this.st.lastPushOk = false;
      console.error("[git] push failed:", e.message);
    }
  }
}

let current: DeskGit | null = null;
export function setDeskGit(g: DeskGit) { current = g; }
/** For the health page. */
export function gitStatus(): GitStatus {
  return current?.status() ?? { lastCommit: null, lastPush: null, lastPushOk: null, pending: false };
}
