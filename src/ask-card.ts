// Question cards: an agent in a pair pane stopped on a question (Claude's AskUserQuestion, a permission
// prompt, the "submit your answers?" review), shown as a card in the page and answered from there.
// The desk reads the pane's screen; it never guesses an answer, it only types the key the user picked:
//   a digit picks an option (toggles it in a multi-select), Tab moves to the next question,
//   "Type something" = its digit, the text, Enter.
import type { Pairs } from "./pair.js";

export interface CardOpt { n: number; label: string; desc?: string; checked?: boolean; other?: boolean }
export interface Card {
  question: string;
  options: CardOpt[];
  multi: boolean; // checkboxes: picks toggle, "Next" moves on
  tabs?: { label: string; done: boolean }[]; // several questions in one ask
  note?: string; // the review screen's summary of the answers so far
}
export type CardAnswer = { pick: number } | { text: string } | { next: true };

const FOOTER = /Enter to (select|confirm).*Esc to cancel/;
const OPT = /^\s*(?:❯\s*)?(\d+)\.\s+(?:\[([ ✔x])\]\s+)?(.*?)\s*$/;
const RULE = /^[─━\s]+$/;
const OTHER = /^Type something\.?$/;

/** The question the pane's screen shows, or null when it shows none. */
export function parseCard(screen: string): Card | null {
  const ls = screen.split("\n").map((l) => l.trimEnd());
  let end = -1;
  for (let i = ls.length - 1; i >= 0 && end < 0; i--) if (FOOTER.test(ls[i])) end = i;
  const sub = ls.findIndex((l) => /Ready to submit your answers\?/.test(l));
  if (end < 0 && sub >= 0) end = ls.length; // the review screen: its footer may sit below the visible rows
  if (end < 0) return null;
  let first = -1;
  for (let i = end - 1; i >= 0; i--) if (/^\s*(?:❯\s*)?1\.\s/.test(ls[i])) { first = i; break; }
  if (first < 0) return null;
  let q = first - 1;
  while (q >= 0 && !ls[q].trim()) q--;
  if (q < 0 || RULE.test(ls[q])) return null;
  const question = ls[q].trim();
  const options: CardOpt[] = [];
  for (let i = first; i < end; i++) {
    const l = ls[i];
    if (!l.trim() || RULE.test(l) || l.trim() === "Next") continue;
    const m = OPT.exec(l);
    if (m) {
      if (m[3] === "Chat about this") continue; // leaves the question for a chat: do that in the terminal
      options.push({ n: Number(m[1]), label: m[3], ...(m[2] !== undefined ? { checked: m[2] !== " " } : {}), ...(OTHER.test(m[3]) ? { other: true } : {}) });
    } else if (options.length && /^\s{3,}\S/.test(l)) {
      const o = options[options.length - 1];
      o.desc = (o.desc ? o.desc + " " : "") + l.trim();
    }
  }
  if (!options.length) return null;
  const card: Card = { question, options, multi: options.some((o) => o.checked !== undefined) };
  for (let i = q - 1; i >= Math.max(0, q - 14) && !RULE.test(ls[i]); i--) { // the review screen puts its summary in between
    if (!/[☐☒]/.test(ls[i])) continue;
    const tabs = [...ls[i].matchAll(/([☐☒])\s+([^☐☒✔←→]+?)(?=\s{2,}|\s*[☐☒✔→]|$)/g)].map((t) => ({ label: t[2].trim(), done: t[1] === "☒" }));
    if (tabs.length > 1) card.tabs = tabs;
    break;
  }
  if (sub >= 0) {
    const from = ls.findIndex((l) => /Review your answers/.test(l));
    if (from >= 0 && from < sub) card.note = ls.slice(from + 1, sub).map((l) => l.trim()).filter(Boolean).join(" ").replace(/●\s*/g, "· ").replace(/^· /, "");
  }
  return card;
}

/** herdr steps that give the answer: keys to press, text to type. */
export function answerSteps(card: Card, a: CardAnswer): ({ keys: string[] } | { text: string })[] {
  if ("next" in a) {
    if (!card.multi && !card.tabs) throw new Error("this question has no next step");
    return [{ keys: ["tab"] }];
  }
  if ("text" in a) {
    const o = card.options.find((x) => x.other);
    const t = a.text.replace(/\s+/g, " ").trim();
    if (!o) throw new Error("this question takes no typed answer");
    if (!t) throw new Error("empty answer");
    if (o.n > 9) throw new Error("option out of reach");
    return [{ keys: [String(o.n)] }, { text: t }, { keys: ["enter"] }];
  }
  const o = card.options.find((x) => x.n === a.pick);
  if (!o) throw new Error(`no option ${a.pick}`);
  if (o.n > 9) throw new Error("option out of reach");
  return [{ keys: [String(o.n)] }];
}

export interface CardEvent { sourceId: string; threadId: string; role: "builder" | "reviewer"; card: Card | null }

/** Every couple of seconds: read each open pair pane and report when its question appears, changes or goes. */
export class AskCards {
  private last = new Map<string, string>(); // "source/tab/role" → JSON of the card shown
  private busy = false;
  constructor(private pairs: Pairs, private onChange: (e: CardEvent) => void) {}

  start(everyMs = 2_000): void {
    setInterval(() => void this.tick(), everyMs).unref();
  }

  /** Cards showing now (for a page that just connected). */
  current(): CardEvent[] {
    return [...this.last].map(([k, j]) => {
      const [sourceId, threadId, role] = k.split("\u0000") as [string, string, CardEvent["role"]];
      return { sourceId, threadId, role, card: JSON.parse(j) };
    });
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const live = new Set<string>();
      for (const pr of this.pairs.list()) {
        for (const tab of Object.keys(pr.tabs)) {
          for (const role of ["builder", "reviewer"] as const) {
            const k = [pr.sourceId, tab, role].join("\u0000");
            live.add(k);
            const card = parseCard(await this.pairs.screenOf(pr.sourceId, tab, role).catch(() => ""));
            const j = card ? JSON.stringify(card) : undefined;
            if (j === this.last.get(k)) continue;
            if (j) this.last.set(k, j); else this.last.delete(k);
            this.onChange({ sourceId: pr.sourceId, threadId: tab, role, card });
          }
        }
      }
      for (const k of [...this.last.keys()]) if (!live.has(k)) { // tab closed with a question up
        const [sourceId, threadId, role] = k.split("\u0000") as [string, string, CardEvent["role"]];
        this.last.delete(k);
        this.onChange({ sourceId, threadId, role, card: null });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Type the user's answer into the pane, if it still shows the same question. */
  async answer(sourceId: string, threadId: string, role: CardEvent["role"], question: string, a: CardAnswer): Promise<void> {
    const card = parseCard(await this.pairs.screenOf(sourceId, threadId, role));
    if (!card || card.question !== question) throw new Error("that question is no longer showing");
    for (const s of answerSteps(card, a)) await this.pairs.typeInto(sourceId, threadId, role, s);
    setTimeout(() => void this.tick(), 400); // the next question or the agent's reply, without waiting a full beat
  }
}
