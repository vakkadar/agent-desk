// Notes tab: day view of notes/activity rows (FR-8).
type Row = { ts: string; source_id: string; thread_id: string; kind: string; prompt?: string; summary?: string; tool?: string; detail?: string;
  files_changed?: string[]; tokens_in?: number; tokens_out?: number; cost?: number; duration_ms?: number; outcome?: string };

const q = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const today = () => new Date().toISOString().slice(0, 10);
let date = today();
let send: (m: unknown) => void = () => {};

function shift(days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  date = d.toISOString().slice(0, 10);
  load();
}
export function load() {
  q<HTMLInputElement>("#notesDate").value = date;
  send({ type: "notes", date });
}
export function initNotes(sendFn: (m: unknown) => void) {
  send = sendFn;
  q("#notesPrev").addEventListener("click", () => shift(-1));
  q("#notesNext").addEventListener("click", () => shift(1));
  q("#notesToday").addEventListener("click", () => { date = today(); load(); });
  const form = q<HTMLFormElement>("#noteAdd");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ta = form.elements.namedItem("text") as HTMLTextAreaElement;
    if (!ta.value.trim()) return;
    send({ type: "note", text: ta.value });
    ta.value = "";
    date = today(); // server replies with today's notes
  });
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) form.requestSubmit(); });
  q<HTMLInputElement>("#notesDate").addEventListener("change", (e) => { date = (e.target as HTMLInputElement).value || date; load(); });
}
export function showNotes(on: boolean) {
  q("#notesView").hidden = !on;
  q("#cards").hidden = on;
  q("#prompt").hidden = on;
  if (on) load();
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function renderNotes(d: string, rows: Row[]) {
  if (d !== date) return;
  const list = q("#notesList");
  const shown = rows.filter((r) => r.kind !== "prompt");
  if (!shown.length) { list.replaceChildren(el("div", "note-m", `Nothing on ${d}. Every agent turn is recorded here automatically; add your own notes above.`)); return; }
  list.replaceChildren(...shown.map((r) => {
    const c = el("div", `note note-${r.kind}`);
    const where = r.source_id ? `${r.source_id}/${r.thread_id}` : "desk";
    c.append(el("div", "note-h", `${r.ts.slice(11, 19)}  ${r.kind}  ${where}`));
    if (r.kind === "response") {
      if (r.prompt) c.append(el("div", "note-q", r.prompt));
      c.append(el("div", "note-b", r.summary ?? ""));
      if (r.files_changed?.length) c.append(el("div", "note-m", "files: " + r.files_changed.join(", ")));
      c.append(el("div", "note-m", [r.outcome, r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + "s" : "",
        `${r.tokens_in ?? 0}/${r.tokens_out ?? 0} tok`, r.cost != null ? "$" + r.cost.toFixed(4) : ""].filter(Boolean).join(" · ")));
    } else if (r.kind === "tool" || r.kind === "approval") {
      c.append(el("div", "note-m", `${r.tool ?? ""} ${r.detail ?? ""}`));
    } else {
      c.append(el("div", "note-b", r.summary ?? ""));
    }
    return c;
  }));
}
