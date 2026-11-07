// Minimal SPA: connect, replay, render turn cards per thread.
type Ev = { seq: number; ts: string; sourceId: string; threadId: string; event: any };

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
    $("#status").textContent = "reconnecting…";
    setTimeout(connect, (state.retry = Math.min(state.retry * 2, 10_000)));
  };
}

function onMsg(m: any) {
  if (m.type === "welcome") {
    state.role = m.role;
    state.sources = m.sources;
    $("#status").textContent = m.role === "action" ? "connected" : "read-only";
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
  } else if (m.type === "error") {
    $("#status").textContent = `error: ${m.error}`;
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
  let card: HTMLElement | null = null;
  let answer: HTMLElement | null = null;
  for (const { event: ev } of evs) {
    if (ev.kind === "prompt" || !card) {
      card = document.createElement("div");
      card.className = "card";
      const q = document.createElement("div");
      q.className = "q";
      q.textContent = ev.kind === "prompt" ? ev.text : "(continued)";
      card.append(q);
      answer = null;
      root.append(card);
      if (ev.kind === "prompt") continue;
    }
    if (ev.kind === "text") {
      if (!answer) { answer = document.createElement("div"); answer.className = "a"; card.append(answer); }
      answer.textContent += ev.text;
    } else if (ev.kind === "tool_call" || ev.kind === "tool_result") {
      const d = document.createElement("details");
      const s = document.createElement("summary");
      s.textContent = ev.kind === "tool_call" ? `tool: ${ev.name}` : `result${ev.isError ? " (error)" : ""}`;
      const pre = document.createElement("pre");
      pre.textContent = ev.kind === "tool_call" ? JSON.stringify(ev.input, null, 2) : ev.output;
      d.append(s, pre);
      card.append(d);
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
function alertStatus(t: string) { $("#status").textContent = t; }

$("#tabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b || b.disabled) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  state.mode = b.dataset.mode!;
  state.thread = state.mode === "ask" ? "ask" : "";
  renderThreads();
});
$("#attach").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  act({ type: "attach", location: (f.elements.namedItem("location") as HTMLInputElement).value });
  f.reset();
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

connect();
