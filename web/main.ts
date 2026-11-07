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
    if (!state.sources.some((s) => s.id === state.source)) state.source = GENERAL;
    if (isGeneral()) state.mode = "ask";
    if (!$("main").classList.contains("paneled") && state.mode !== "notes") syncTabs();
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
  } else if (m.type === "focus") {
    // Server picked/created the General thread for the prompt just sent.
    state.source = m.sourceId;
    state.thread = m.threadId;
    renderSources();
  } else if (m.type === "notes") {
    renderNotes(m.date, m.rows);
  } else if (m.type === "ls") {
    if (m.tag === "browse") renderBrowser(m.dir, m.entries);
    else if (attachKind() === "local" && m.path === locInput.value) fillLocs(m.entries); // drop stale replies
  } else if (m.type === "sessions") {
    if (m.sourceId === state.source) renderResume(m.sessions);
  } else if (m.type === "usage") {
    onUsage(m);
  } else if (m.type === "search") {
    onSearch(m);
  } else if (m.type === "error") {
    alertStatus(`error: ${m.error}`, "warn");
    // Rejected prompt: show why under the box and give the text back.
    const ta = $<HTMLTextAreaElement>("#prompt textarea");
    if (lastSent && Date.now() - lastSent.at < 10_000) {
      if (!ta.value.trim()) ta.value = lastSent.text;
      const e = $("#promptErr");
      e.textContent = m.error;
      e.hidden = false;
      lastSent = null;
    }
  }
}

const GENERAL = "general";
const isGeneral = () => state.source === GENERAL;
/** Highlight the tab matching state: General when the General source is picked, else the mode. */
function syncTabs() {
  const on = isGeneral() ? "general" : state.mode;
  document.querySelectorAll<HTMLElement>("#tabs button").forEach((x) => x.classList.toggle("on", x.dataset.mode === on));
}

function renderSources() {
  const ul = $("#sources");
  // General has its own tab; the Sources list holds project folders only.
  for (const id of ["#srcHead", "#sources", "#attach"]) $(id).hidden = isGeneral();
  $("#thrHead").textContent = isGeneral() ? "Questions" : "Threads";
  ul.replaceChildren(...state.sources.filter((s) => s.id !== GENERAL).map((s) => li(s.id, s.id === state.source, () => {
    state.source = s.id;
    localStorageSet("source", s.id);
    localStorageSet("lastSource", s.id);
    state.thread = state.mode === "ask" ? "ask" : "";
    renderSources();
  })));
  renderThreads();
}

function renderThreads() {
  const src = state.sources.find((s) => s.id === state.source);
  const ta = $<HTMLTextAreaElement>("#prompt textarea");
  if (src?.id === GENERAL && state.mode === "ask") {
    // General: "New question" entry + past questions, newest first.
    const qs = Object.values<any>(src.threads).filter((t) => t.id !== "ask").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!state.thread) state.thread = "ask";
    $("#threads").replaceChildren(
      li("+ New question", state.thread === "ask", () => { state.thread = "ask"; renderThreads(); }),
      ...qs.map((t) => li(`${t.id} · ${t.title ?? ""}`, t.id === state.thread, () => { state.thread = t.id; renderThreads(); })),
    );
    ta.placeholder = state.thread === "ask"
      ? "New question (new session). To continue one, pick it in the list or start with c: q-3"
      : `Continuing ${state.thread}. Pick "+ New question" for a fresh session.`;
  } else {
    const ids = src ? Object.keys(src.threads).filter((t) => (state.mode === "ask" ? t === "ask" : t.startsWith(state.mode + "-"))) : [];
    $("#threads").replaceChildren(...ids.map((t) => li(t, t === state.thread, () => { state.thread = t; renderThreads(); })));
    ta.placeholder = "Message (Ctrl+Enter to send)";
  }
  const nb = $<HTMLButtonElement>("#newThread");
  nb.hidden = !src || src.id === GENERAL || state.mode === "ask" || state.role !== "action";
  nb.textContent = `New ${state.mode}`;
  $("#resumeBtn").hidden = nb.hidden || src?.kind !== "local";
  if ($("#resumeBtn").hidden) $("#resumeList").hidden = true;
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
    const hint = !state.source ? "Attach a source to get started." : !state.thread ? "Pick or create a thread." : "No messages yet. Ask something above.";
    root.append(Object.assign(document.createElement("div"), { className: "empty", textContent: hint }));
    return;
  }
  let card: HTMLElement | null = null;
  let answer: HTMLElement | null = null;
  let steps: HTMLDetailsElement | null = null; // a card's tool calls, folded into one line
  let nSteps = 0;
  let running = false; // last turn has no "done" yet
  let ctx: { used: number; limit: number } | null = null; // after the newest turn
  for (const { event: ev, seq } of evs) {
    if (ev.kind === "prompt") running = true;
    if (ev.kind === "context") { ctx = ev; continue; }
    else if (ev.kind === "done") running = false;
    if (ev.kind === "prompt" || !card) {
      card = document.createElement("div");
      card.className = "card";
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = ev.kind === "prompt" ? ev.text : "(continued)";
      card.append(q);
      answer = null;
      steps = null;
      nSteps = 0;
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
      s.textContent = ev.kind === "tool_call" ? `${ev.name}: ${toolGist(ev.input)}` : `result${ev.isError ? " (error)" : ""}`;
      const pre = document.createElement("pre");
      pre.textContent = ev.kind === "tool_call" ? JSON.stringify(ev.input, null, 2) : ev.output;
      d.append(s, pre);
      if (!steps) {
        steps = document.createElement("details");
        steps.className = "steps";
        steps.append(document.createElement("summary"));
        card.append(steps);
      }
      steps.append(d);
      if (ev.kind === "tool_call") nSteps++;
      steps.querySelector(":scope > summary")!.textContent = `${nSteps} step${nSteps === 1 ? "" : "s"} · last: ${ev.kind === "tool_call" ? s.textContent : steps.dataset.last ?? ""}`;
      if (ev.kind === "tool_call") steps.dataset.last = s.textContent ?? "";
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
      steps = null; // steps after an approval start a new group, keeping order readable
    } else if (ev.kind === "state" && ev.state === "blocked") {
      const meta = document.createElement("div");
      meta.className = "meta working";
      meta.textContent = "waiting for approval in the terminal window";
      card.append(meta);
    } else if (ev.kind === "usage" || ev.kind === "done") {
      if (ev.kind === "done") // turn over: approvals left open can no longer be answered
        card.querySelectorAll(".approval .ap-btns").forEach((r) => {
          const x = document.createElement("div");
          x.className = "meta";
          x.textContent = "expired (turn ended)";
          r.replaceWith(x);
        });
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = ev.kind === "usage"
        ? `${ev.tokensIn} in · ${ev.tokensOut} out${ev.costUsd != null ? ` · $${ev.costUsd.toFixed(4)}` : ""}`
        : ev.outcome === "ok" ? "done" : `${ev.outcome}: ${ev.error ?? ""}`;
      card.append(meta);
    }
  }
  showCtx(ctx, running);
  if (running && card) {
    const w = document.createElement("div");
    w.className = "meta working";
    w.textContent = "working…";
    card.append(w);
  }
  if (running && card && state.role === "action") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stop";
    b.textContent = "Stop";
    const src = state.source, thr = state.thread;
    b.onclick = () => { b.disabled = true; b.textContent = "Stopping…"; act({ type: "cancel", sourceId: src, threadId: thr }); };
    card.append(b);
  }
  // Text box sits on top, so newest turn goes right under it.
  root.append(...[...root.children].reverse());
  root.scrollTop = 0;
}

/** Context ≥ 70% full → suggest /compact under the text box. */
function showCtx(c: { used: number; limit: number } | null, running: boolean) {
  const el = $("#ctxHint");
  const pct = c ? Math.round((100 * c.used) / c.limit) : 0;
  el.hidden = !c || pct < 70 || running;
  if (el.hidden) return;
  el.replaceChildren(`Session context ${pct}% full (${Math.round(c!.used / 1000)}k). Compact it before it fills up. `);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Send /compact";
  b.onclick = () => sendText("/compact");
  el.append(b);
}

function sendText(text: string) {
  if (!state.source || (!state.thread && !isGeneral())) return alertStatus("pick a source and thread");
  $("#promptErr").hidden = true;
  lastSent = { text, at: Date.now() };
  act({ type: "prompt", sourceId: state.source, threadId: state.thread, text });
}

// ⋯ menu next to Send: Claude commands and the prefixes this box understands.
const MENU: { label: string; hint: string; run: () => void }[] = [
  { label: "/compact", hint: "summarize the session to free context", run: () => sendText("/compact") },
  { label: "Stop", hint: "stop the running turn", run: () => act({ type: "cancel", sourceId: state.source, threadId: state.thread }) },
  { label: "c: <id> message", hint: "General: continue q-3 · Project: pick window w3", run: () => insert("c: ") },
  { label: "new: message", hint: "Project Ask: separate session, not your open window", run: () => insert("new: ") },
  { label: "/<command>", hint: "any Claude command is passed as typed", run: () => insert("/") },
];
function insert(prefix: string) {
  const ta = $<HTMLTextAreaElement>("#prompt textarea");
  if (!ta.value.startsWith(prefix)) ta.value = prefix + ta.value;
  ta.focus();
}
{
  const menu = $("#actMenu");
  menu.replaceChildren(...MENU.map((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<b></b><span></span>`;
    b.querySelector("b")!.textContent = m.label;
    b.querySelector("span")!.textContent = m.hint;
    b.onclick = () => { menu.hidden = true; m.run(); };
    return b;
  }));
  $("#actBtn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target as Node)) menu.hidden = true; });
}

/** One-line gist of a tool call's input, so the card says what the agent is doing. */
function toolGist(input: any): string {
  const v = input?.command ?? input?.description ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.prompt;
  const s = typeof v === "string" ? v : JSON.stringify(input ?? "");
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
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
  if (b.dataset.mode === "general") {
    showPanel("");
    showNotes(false);
    state.mode = "ask";
    state.source = GENERAL;
    state.thread = "ask";
    localStorageSet("source", GENERAL);
    renderSources();
    return;
  }
  if (b.dataset.mode === "usage" || b.dataset.mode === "search" || b.dataset.mode === "web") {
    showPanel(b.dataset.mode);
    return;
  }
  showPanel("");
  state.mode = b.dataset.mode!;
  showNotes(state.mode === "notes");
  state.thread = state.mode === "ask" ? "ask" : "";
  if (isGeneral()) {
    // Leaving General: back to the last project source.
    const last = localStorageGet("lastSource");
    state.source = state.sources.some((s) => s.id === last) ? last! : (state.sources.find((s) => s.id !== GENERAL)?.id ?? "");
    localStorageSet("source", state.source);
  }
  renderSources();
});
// Usage / Search panels (read-only; work for any role) + phone sidebar toggle.
const wsSend = (m: unknown) => state.ws?.readyState === WebSocket.OPEN && state.ws.send(JSON.stringify(m));
function showPanel(which: string) {
  const mainEl = $("main");
  mainEl.classList.toggle("paneled", !!which);
  $("#panelUsage").hidden = which !== "usage";
  $("#panelSearch").hidden = which !== "search";
  $("#panelWeb").hidden = which !== "web";
  if (which === "web") $<HTMLInputElement>("#panelWeb input").focus();
  if (which === "usage") showUsage();
  if (which === "search") showSearch();
}
initUsage($("#panelUsage"), (range) => wsSend({ type: "usage", range }));
// Web: Google search (or a pasted URL) in a new browser tab.
$("#panelWeb form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("#panelWeb input").value.trim();
  if (!q) return;
  const url = /^https?:\/\/\S+$/i.test(q) ? q : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  window.open(url, "_blank", "noopener");
});
initSearch($("#panelSearch"), (q) => wsSend({ type: "search", q }), gotoHit);
function gotoHit(h: Hit) {
  const mode = h.threadId.startsWith("design-") ? "design" : h.threadId.startsWith("code-") ? "code" : "ask";
  state.mode = mode;
  state.source = h.sourceId;
  state.thread = h.threadId;
  localStorageSet("source", h.sourceId);
  syncTabs();
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
// Resume picker: past Claude sessions in this source's folder (e.g. started in a terminal).
type ClaudeSession = { id: string; mtime: string; title: string; live: boolean };
$("#resumeBtn").addEventListener("click", () => act({ type: "sessions", sourceId: state.source }));
$("#closeResume").addEventListener("click", () => { $("#resumeList").hidden = true; });
function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
function renderResume(list: ClaudeSession[]) {
  const box = $("#resumeList");
  box.hidden = false;
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "m";
    li.textContent = "No Claude sessions found for this folder.";
    box.querySelector("ul")!.replaceChildren(li);
    return;
  }
  box.querySelector("ul")!.replaceChildren(...list.map((s) => {
    const li = document.createElement("li");
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = s.title || "(no prompt)";
    t.title = s.title;
    const m = document.createElement("div");
    m.className = "m";
    m.textContent = `${s.id.slice(0, 8)} · ${ago(s.mtime)}`;
    if (s.live) {
      const b = document.createElement("span");
      b.className = "live";
      b.textContent = " · active";
      m.append(b);
    }
    li.append(t, m);
    li.addEventListener("click", () => {
      // An active session is probably open in a terminal: writing to it from here would interleave turns.
      let fork = false;
      if (s.live) {
        if (!confirm("This session looks open in a terminal right now.\n\nOK = start a forked copy here (safe).\nCancel = do nothing.")) return;
        fork = true;
      }
      const mode = state.mode === "design" ? "design" : "code";
      act({ type: "thread", sourceId: state.source, mode, resume: s.id, fork });
      box.hidden = true;
    });
    return li;
  }));
}
const promptForm = $<HTMLFormElement>("#prompt");
let lastSent: { text: string; at: number } | null = null;
promptForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const ta = promptForm.elements.namedItem("text") as HTMLTextAreaElement;
  if (!state.source || (!state.thread && !isGeneral()) || !ta.value.trim()) return alertStatus("pick a source and thread");
  sendText(ta.value);
  ta.value = "";
});
promptForm.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.ctrlKey) promptForm.requestSubmit();
});

import "./health.js";
import { initTerminal } from "./terminal.js";
initTerminal();

connect();
