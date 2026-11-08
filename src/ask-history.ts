// Turns run on an Ask target other than local Claude are logged with a tagged prompt:
//   <target>:<detail>[<thread>]: <question>
// e.g. "hub:expert deepseek/deepseek-chat[q-3]: what is dharma?". The tag lets the next
// turn on the same target send its earlier turns as history, and only those: answers from
// local Claude or another target never leave for a third party.
// No node imports: the web page uses this too.

export type Msg = { role: "user" | "assistant"; content: string };
type Ev = { sourceId: string; threadId: string; event: any };

export function promptTag(target: string, detail: string, threadId: string, text: string): string {
  return `${target}:${detail}[${threadId}]: ${text}`;
}

/** Signature line appended to a target's answer; stripped again for history. */
export const signature = (target: string, detail: string) => `\n\n_— ${target}${detail ? ` · ${detail}` : ""}_`;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Earlier turns on `target` in this thread, oldest first. The newest prompt (being asked now) is left out. */
export function targetHistory(evs: Ev[], sourceId: string, threadId: string, target: string, max = 20): Msg[] {
  const tag = new RegExp(`^${esc(target)}:[^\\[\\n]*\\[[^\\]]*\\]: ([\\s\\S]*)$`);
  const out: Msg[] = [];
  let answer: string[] | null = null;
  const flush = () => {
    if (answer?.length) out.push({ role: "assistant", content: answer.join("").replace(/\n\n_— [^\n]*_$/, "") });
    answer = null;
  };
  for (const e of evs) {
    if (e.sourceId !== sourceId || e.threadId !== threadId) continue;
    const ev = e.event;
    if (ev.kind === "prompt") {
      flush();
      const m = tag.exec(String(ev.text));
      if (m) { out.push({ role: "user", content: m[1] }); answer = []; }
    } else if (ev.kind === "text" && answer) answer.push(String(ev.text));
  }
  flush();
  if (out.length && out[out.length - 1].role === "user") out.pop();
  // Drop a question that never got an answer (error), so roles keep alternating.
  const clean: Msg[] = [];
  for (const m of out) {
    if (m.role === "user" && clean.length && clean[clean.length - 1].role === "user") clean.pop();
    clean.push(m);
  }
  if (clean.length && clean[clean.length - 1].role === "user") clean.pop();
  return clean.slice(-max);
}
