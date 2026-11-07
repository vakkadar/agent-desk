// History tab (FR-10): server-side full-text search over the journal; click a hit to jump to it.
export type Hit = { sourceId: string; threadId: string; seq: number; ts: string; kind: string; snippet: string; start: number; len: number };

let root: HTMLElement;
let request: (q: string) => void;
let pick: (h: Hit) => void;
let input: HTMLInputElement;
let list: HTMLElement;
let timer = 0;

export function initSearch(el: HTMLElement, req: (q: string) => void, onPick: (h: Hit) => void) {
  root = el;
  request = req;
  pick = onPick;
  const form = document.createElement("form");
  form.className = "searchbar";
  input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Search prompts, answers, tool output…";
  input.autocomplete = "off";
  form.append(input);
  form.onsubmit = (e) => { e.preventDefault(); request(input.value); };
  input.oninput = () => { clearTimeout(timer); timer = window.setTimeout(() => request(input.value), 250); };
  list = document.createElement("div");
  list.className = "hits";
  root.append(form, list);
}

export function showSearch() {
  input.focus();
}

export function onSearch(m: { q: string; hits: Hit[] }) {
  if (m.q !== input.value) return; // stale
  list.replaceChildren();
  if (!m.q.trim()) return;
  if (!m.hits.length) {
    list.append(Object.assign(document.createElement("div"), { className: "empty", textContent: "No matches." }));
    return;
  }
  for (const h of m.hits) {
    const el = document.createElement("div");
    el.className = "hit";
    el.tabIndex = 0;
    const meta = document.createElement("div");
    meta.className = "hitmeta";
    meta.textContent = `${h.sourceId} / ${h.threadId} · ${h.kind} · ${new Date(h.ts).toLocaleString()}`;
    const snip = document.createElement("div");
    snip.className = "snip";
    const mark = document.createElement("mark");
    mark.textContent = h.snippet.slice(h.start, h.start + h.len);
    snip.append(h.snippet.slice(0, h.start), mark, h.snippet.slice(h.start + h.len));
    el.append(meta, snip);
    el.onclick = () => pick(h);
    el.onkeydown = (e) => { if (e.key === "Enter") pick(h); };
    list.append(el);
  }
}
