// Minimal SPA: connect, replay, render turn cards per thread.
import { renderMarkdown } from "./markdown.js";
import { initUsage, showUsage, onUsage } from "./usage.js";
import { initSearch, showSearch, onSearch, type Hit } from "./search.js";
type Ev = { seq: number; ts: string; sourceId: string; threadId: string; event: any };

import { initNotes, showNotes, renderNotes } from "./notes.js";

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const state = {
  ws: null as WebSocket | null,
  lastSeq: Number(localStorageGet("lastSeq") ?? 0),
  role: "readonly",
  sources: [] as any[],
  source: localStorageGet("source") ?? "",
  thread: "ask",
  mode: "ask",
  events: [] as Ev[],
  retry: 500,
};

function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private mode */ }
}

function token(): string | undefined {
  const t = new URLSearchParams(location.hash.slice(1)).get("token");
  if (t) localStorageSet("token", t);
  return t ?? localStorageGet("token") ?? undefined;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.retry = 500;
    // Full replay on first load (lastSeq 0 in memory); incremental on reconnect.
    ws.send(JSON.stringify({ type: "hello", token: token(), lastSeq: state.events.length ? state.lastSeq : 0 }));
  };
  ws.onmessage = (m) => onMsg(JSON.parse(m.data));
  ws.onclose = () => {
    alertStatus("reconnecting…", "warn");
    setTimeout(connect, (state.retry = Math.min(state.retry * 2, 10_000)));
  };
}

function onMsg(m: any) {
  if (m.type === "welcome") {
    state.role = m.role;
    state.sources = m.sources;
    alertStatus(m.role === "action" ? "connected" : "read-only", m.role === "action" ? "ok" : "");
    renderSources();
  } else if (m.type === "sources") {
    state.sources = m.sources;
    renderSources();
  } else if (m.type === "event") {
    const e: Ev = m.e;
    if (state.events.some((x) => x.seq === e.seq)) return;
    state.events.push(e);
    state.lastSeq = Math.max(state.lastSeq, e.seq);
    localStorageSet("lastSeq", String(state.lastSeq));
    if (e.sourceId === state.source && e.threadId === state.thread) renderCards();
  } else if (m.type === "notes") {
    renderNotes(m.date, m.rows);
  } else if (m.type === "ls") {
    if (m.tag === "browse") renderBrowser(m.dir, m.entries);
    else if (attachKind() === "local" && m.path === locInput.value) fillLocs(m.entries); // drop stale replies
  } else if (m.type === "usage") {
    onUsage(m);
  } else if (m.type === "search") {
    onSearch(m);
  } else if (m.type === "error") {
    alertStatus(`error: ${m.error}`, "warn");
  }
}

function renderSources() {
  const ul = $("#sources");
  ul.replaceChildren(...state.sources.map((s) => li(s.id, s.id === state.source, () => {
    state.source = s.id;
    localStorageSet("source", s.id);
    state.thread = state.mode === "ask" ? "ask" : "";
    renderSources();
  })));
  renderThreads();
}

function renderThreads() {
  const src = state.sources.find((s) => s.id === state.source);
  const ids = src ? Object.keys(src.threads).filter((t) => (state.mode === "ask" ? t === "ask" : t.startsWith(state.mode + "-"))) : [];
  $("#threads").replaceChildren(...ids.map((t) => li(t, t === state.thread, () => { state.thread = t; renderThreads(); })));
  const nb = $<HTMLButtonElement>("#newThread");
  nb.hidden = !src || state.mode === "ask" || state.role !== "action";
  nb.textContent = `New ${state.mode}`;
  renderCards();
}

function li(text: string, on: boolean, click: () => void) {
  const el = document.createElement("li");
  el.textContent = text;
  el.className = on ? "on" : "";
  el.onclick = click;
  return el;
}

/** Group events into turn cards: a prompt starts a card; following events fill it. */
function renderCards() {
  const evs = state.events.filter((e) => e.sourceId === state.source && e.threadId === state.thread);
  const root = $("#cards");
  root.replaceChildren();
  if (!evs.length) {
    const hint = !state.source ? "Attach a source to get started." : !state.thread ? "Pick or create a thread." : "No messages yet. Ask something below.";
    root.append(Object.assign(document.createElement("div"), { className: "empty", textContent: hint }));
    return;
  }
  let card: HTMLElement | null = null;
  let answer: HTMLElement | null = null;
  for (const { event: ev, seq } of evs) {
    if (ev.kind === "prompt" || !card) {
      card = document.createElement("div");
      card.className = "card";
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = ev.kind === "prompt" ? ev.text : "(continued)";
      card.append(q);
      answer = null;
      root.append(card);
      card.dataset.seq = String(seq);
      if (ev.kind === "prompt") { card.dataset.last = String(seq); continue; }
    }
    card.dataset.last = String(seq);
    if (ev.kind === "text") {
      if (!answer) { answer = document.createElement("div"); answer.className = "a md"; card.append(answer); }
      answer.dataset.raw = (answer.dataset.raw ?? "") + ev.text;
      answer.innerHTML = renderMarkdown(answer.dataset.raw);
    } else if (ev.kind === "tool_call" || ev.kind === "tool_result") {
      const d = document.createElement("details");
      const s = document.createElement("summary");
      s.textContent = ev.kind === "tool_call" ? `tool: ${ev.name}` : `result${ev.isError ? " (error)" : ""}`;
      const pre = document.createElement("pre");
      pre.textContent = ev.kind === "tool_call" ? JSON.stringify(ev.input, null, 2) : ev.output;
      d.append(s, pre);
      card.append(d);
      answer = null;
    } else if (ev.kind === "approval_request") {
      const res = evs.find((x) => x.event.kind === "approval_result" && x.event.id === ev.id)?.event as any;
      const ap = document.createElement("div");
      ap.className = "approval";
      const h = document.createElement("div");
      h.className = "ap-head";
      h.textContent = `Approval needed: ${ev.tool}`;
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(ev.input, null, 2);
      ap.append(h, pre);
      if (res) {
        ap.classList.add(res.decision === "allow" ? "ok" : "no");
        const r = document.createElement("div");
        r.className = "meta";
        r.textContent = `${res.decision === "allow" ? "approved" : "denied"} (${res.by})`;
        ap.append(r);
      } else if (state.role === "action") {
        const row = document.createElement("div");
        row.className = "ap-btns";
        for (const allow of [true, false]) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = allow ? "Approve" : "Deny";
          b.className = allow ? "ap-ok" : "ap-no";
          b.onclick = () => { row.querySelectorAll("button").forEach((x) => (x.disabled = true)); act({ type: "approve", id: ev.id, allow }); };
          row.append(b);
        }
        ap.append(row);
      } else {
        const r = document.createElement("div");
        r.className = "meta";
        r.textContent = "waiting for approval (read-only view)";
        ap.append(r);
      }
      card.append(ap);
      answer = null;
    } else if (ev.kind === "usage" || ev.kind === "done") {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = ev.kind === "usage"
        ? `${ev.tokensIn} in · ${ev.tokensOut} out${ev.costUsd != null ? ` · $${ev.costUsd.toFixed(4)}` : ""}`
        : ev.outcome === "ok" ? "done" : `${ev.outcome}: ${ev.error ?? ""}`;
      card.append(meta);
    }
  }
  root.scrollTop = root.scrollHeight;
}

function act(m: unknown) {
  if (state.role !== "action") return alertStatus("read-only");
  state.ws?.send(JSON.stringify(m));
}
function alertStatus(t: string, cls = "") {
  const s = $("#status");
  s.textContent = t;
  s.className = cls;
}

// Theme: auto (follow OS) → light → dark. Head script applies the saved choice before paint.
const THEMES = ["auto", "light", "dark"];
const THEME_LABEL: Record<string, string> = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
const themeBtn = $<HTMLButtonElement>("#theme");
let theme = localStorageGet("theme") ?? "auto";
function applyTheme() {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  themeBtn.textContent = THEME_LABEL[theme] ?? THEME_LABEL.auto;
  themeBtn.title = `Theme: ${theme} (click to change)`;
}
themeBtn.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  localStorageSet("theme", theme);
  applyTheme();
});
applyTheme();

initNotes((m) => state.ws?.send(JSON.stringify(m)));
$("#tabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b || b.disabled) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  if (b.dataset.mode === "usage" || b.dataset.mode === "search") {
    showPanel(b.dataset.mode);
    return;
  }
  showPanel("");
  state.mode = b.dataset.mode!;
  showNotes(state.mode === "notes");
  state.thread = state.mode === "ask" ? "ask" : "";
  renderThreads();
});
// Usage / Search panels (read-only; work for any role) + phone sidebar toggle.
const wsSend = (m: unknown) => state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify(m));
function showPanel(which: string) {
  const mainEl = $("main");
  mainEl.classList.toggle("paneled", !!which);
  $("#panelUsage").hidden = which !== "usage";
  $("#panelSearch").hidden = which !== "search";
  if (which === "usage") showUsage();
  if (which === "search") showSearch();
}
initUsage($("#panelUsage"), (range) => wsSend({ type: "usage", range }));
initSearch($("#panelSearch"), (q) => wsSend({ type: "search", q }), gotoHit);
function gotoHit(h: Hit) {
  const mode = h.threadId.startsWith("design-") ? "design" : h.threadId.startsWith("code-") ? "code" : "ask";
  state.mode = mode;
  state.source = h.sourceId;
  state.thread = h.threadId;
  localStorageSet("source", h.sourceId);
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
  showPanel("");
  showNotes(false);
  renderSources();
  const cards = [...document.querySelectorAll<HTMLElement>("#cards .card")];
  const c = cards.find((x) => Number(x.dataset.seq) <= h.seq && h.seq <= Number(x.dataset.last));
  if (c) {
    c.scrollIntoView({ block: "center" });
    c.classList.add("flash");
    setTimeout(() => c.classList.remove("flash"), 1800);
  }
}
$("#sbToggle").addEventListener("click", () => document.body.classList.toggle("sb-open"));
$("#threads").addEventListener("click", () => document.body.classList.remove("sb-open"));

// Attach form: radio picks Local folder (server-side dir autocomplete) or URL (history autocomplete).
const attachForm = $<HTMLFormElement>("#attach");
const locInput = attachForm.elements.namedItem("location") as HTMLInputElement;
const attachKind = () => (attachForm.querySelector("input[name=kind]:checked") as HTMLInputElement).value;

function urlHistory(): string[] {
  try { return JSON.parse(localStorageGet("urls") ?? "[]"); } catch { return []; }
}
function fillLocs(items: string[]) {
  $("#locs").replaceChildren(...items.map((v) => Object.assign(document.createElement("option"), { value: v })));
}
function refreshLocs() {
  if (attachKind() === "url") {
    const fromSources = state.sources.filter((s) => s.kind !== "local").map((s) => s.location);
    fillLocs([...new Set([...urlHistory(), ...fromSources])]);
  } else if (state.role === "action") {
    state.ws?.send(JSON.stringify({ type: "ls", path: locInput.value }));
  }
}

let lsTimer = 0;
locInput.addEventListener("input", () => {
  clearTimeout(lsTimer);
  lsTimer = window.setTimeout(refreshLocs, 150);
});
locInput.addEventListener("focus", refreshLocs);
attachForm.addEventListener("change", (e) => {
  if ((e.target as HTMLInputElement).name !== "kind") return;
  const url = attachKind() === "url";
  locInput.placeholder = url ? "https://…" : "~/projects/…";
  locInput.type = url ? "url" : "text";
  locInput.value = "";
  $("#browse").hidden = url;
  $("#browser").hidden = true;
  refreshLocs();
});

// Folder browser: server lists dirs; click to descend, ".." to go up, select fills the input.
const browser = $("#browser");
let browseDir = "";
function browseTo(dir: string) {
  if (state.role !== "action") return alertStatus("read-only");
  state.ws?.send(JSON.stringify({ type: "ls", tag: "browse", path: dir, limit: 500 }));
}
function renderBrowser(dir: string, entries: string[]) {
  browseDir = dir;
  browser.hidden = false;
  browser.querySelector(".cwd")!.textContent = dir;
  const trimmed = dir.replace(/\/+$/, "");
  const parent = trimmed ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : "";
  const items = entries.map((p) => li(p.slice(dir.length), false, () => browseTo(p)));
  if (parent) items.unshift(li("..", false, () => browseTo(parent)));
  browser.querySelector("ul")!.replaceChildren(...items);
}
$("#browse").addEventListener("click", () => {
  const v = locInput.value.trim();
  browseTo(v ? (v.endsWith("/") ? v : v.slice(0, v.lastIndexOf("/") + 1) || "~/") : "~/");
});
$("#pickDir").addEventListener("click", () => {
  locInput.value = browseDir;
  browser.hidden = true;
  locInput.focus();
});
$("#closeBrowser").addEventListener("click", () => { browser.hidden = true; });
attachForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const location = locInput.value.trim();
  if (attachKind() === "url") {
    if (!/^https?:\/\//.test(location)) return alertStatus("URL must start with http(s)://");
    localStorageSet("urls", JSON.stringify([location, ...urlHistory().filter((u) => u !== location)].slice(0, 20)));
  }
  act({ type: "attach", location });
  locInput.value = "";
});
$("#newThread").addEventListener("click", () => act({ type: "thread", sourceId: state.source, mode: state.mode }));
const promptForm = $<HTMLFormElement>("#prompt");
promptForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const ta = promptForm.elements.namedItem("text") as HTMLTextAreaElement;
  if (!state.source || !state.thread || !ta.value.trim()) return alertStatus("pick a source and thread");
  act({ type: "prompt", sourceId: state.source, threadId: state.thread, text: ta.value });
  ta.value = "";
});
promptForm.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) promptForm.requestSubmit();
});

import "./health.js";

connect();
