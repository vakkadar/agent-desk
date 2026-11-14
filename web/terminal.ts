// FR-18: bottom terminal panel attached live to a herdr session over /pty.
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const root = document.documentElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let wantOpen = false;
let retry = 500;
let retryTimer: number | undefined;
let session = "agent-desk";
let ro: ResizeObserver | null = null;

function token(): string | undefined {
  try { return new URLSearchParams(location.hash.slice(1)).get("token") ?? localStorage.getItem("token") ?? undefined; } catch { return undefined; }
}

function cssVar(n: string): string { return getComputedStyle(root).getPropertyValue(n).trim(); }

function theme(): ITheme {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const forced = root.dataset.theme;
  const isDark = forced ? forced === "dark" : dark;
  return {
    background: cssVar("--sunk") || (isDark ? "#101318" : "#f0f1f4"),
    foreground: cssVar("--fg") || (isDark ? "#e5e7eb" : "#1b1d22"),
    cursor: cssVar("--acc"),
    cursorAccent: cssVar("--sunk"),
    selectionBackground: isDark ? "rgba(139,141,249,0.35)" : "rgba(79,70,229,0.25)",
  };
}

function setOverlay(msg: string | null) {
  const o = $("#termOverlay");
  o.textContent = msg ?? "";
  o.hidden = !msg;
}

function send(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect() {
  if (!wantOpen || !term) return;
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty?session=${encodeURIComponent(session)}`);
  ws = sock;
  sock.onopen = () => {
    fit?.fit();
    sock.send(JSON.stringify({ type: "hello", token: token(), cols: term!.cols, rows: term!.rows }));
  };
  sock.onmessage = (ev) => {
    const d = String(ev.data);
    if (d.startsWith('{"type":"ready"')) {
      try {
        const m = JSON.parse(d);
        retry = 500;
        setOverlay(null);
        term!.options.disableStdin = m.role !== "action";
        $("#termRole").textContent = m.role === "action" ? "" : "read-only";
        term!.reset(); // herdr redraws on attach
        send({ type: "resize", cols: term!.cols, rows: term!.rows });
        return;
      } catch { /* fall through: treat as output */ }
    }
    term!.write(d);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return; // superseded (session switch)
    if (!wantOpen) return;
    if (ev.code === 4003 || ev.code === 4004 || ev.code === 4008) return setOverlay(`terminal refused: ${ev.reason || ev.code}`);
    setOverlay("reconnecting…");
    retryTimer = window.setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  };
}

function disconnect() {
  window.clearTimeout(retryTimer);
  const s = ws;
  ws = null;
  s?.close();
}

async function loadSessions(sel: HTMLSelectElement) {
  let names: string[] = [];
  try { names = await (await fetch("/pty/sessions")).json(); } catch { /* keep fallback */ }
  if (!names.length) names = ["agent-desk", "default"];
  names.sort((a, b) => (a === "agent-desk" ? -1 : b === "agent-desk" ? 1 : a.localeCompare(b)));
  sel.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { value: n, textContent: n })));
  if (names.includes(session)) sel.value = session; else session = sel.value;
}

function copy(text: string) {
  if (text) navigator.clipboard?.writeText(text).catch(() => {});
}

async function paste() {
  try { term?.paste(await navigator.clipboard.readText()); } catch { /* permission denied */ }
}

function build() {
  const host = $("#termHost");
  term = new Terminal({
    fontFamily: cssVar("--mono") || "monospace", fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: theme(), allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ClipboardAddon()); // OSC 52 from herdr/claude -> browser clipboard
  term.loadAddon(new WebLinksAddon());
  term.open(host);
  term.onData((d) => send({ type: "input", data: d }));
  term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
  term.onSelectionChange(() => copy(term!.getSelection())); // copy-on-select
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();
    if (mac ? e.metaKey && k === "c" : e.ctrlKey && e.shiftKey && k === "c") {
      if (term!.hasSelection()) { copy(term!.getSelection()); return false; }
      return mac ? false : true;
    }
    if (mac ? e.metaKey && k === "v" : e.ctrlKey && e.shiftKey && k === "v") { void paste(); return false; }
    return true;
  });
  host.addEventListener("contextmenu", (e) => { e.preventDefault(); void paste(); }); // right-click paste
  ro = new ResizeObserver(() => fit?.fit());
  ro.observe(host);
  // Re-apply colors on theme change.
  new MutationObserver(() => term && (term.options.theme = theme())).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => term && (term.options.theme = theme()));
}

function openPanel() {
  const panel = $("#termPanel");
  panel.hidden = false;
  document.body.classList.add("term-open");
  wantOpen = true;
  if (!term) build();
  void loadSessions($<HTMLSelectElement>("#termSession")).then(() => {
    fit?.fit();
    disconnect();
    retry = 500;
    connect();
    term?.focus();
  });
}

function closePanel() {
  wantOpen = false;
  disconnect();
  setOverlay(null);
  $("#termPanel").hidden = true;
  document.body.classList.remove("term-open");
}

/** Open the panel, optionally on a given herdr session (desk2 menus). */
export function openTerminal(name?: string) {
  if (name) session = name;
  if ($("#termPanel").hidden) openPanel();
  else { disconnect(); retry = 500; term?.reset(); void loadSessions($<HTMLSelectElement>("#termSession")).then(connect); }
}
export function toggleTerminal() { $("#termPanel").hidden ? openPanel() : closePanel(); }

export function initTerminal() {
  const btn = $("#termBtn");
  btn.addEventListener("click", () => ($("#termPanel").hidden ? openPanel() : closePanel()));
  $("#termClose").addEventListener("click", closePanel);
  $<HTMLSelectElement>("#termSession").addEventListener("change", (e) => {
    session = (e.target as HTMLSelectElement).value;
    disconnect();
    retry = 500;
    term?.reset();
    connect();
    term?.focus();
  });
  // Drag-resize the panel height (VS Code style).
  const grip = $("#termGrip");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const h = Math.max(120, Math.min(window.innerHeight - 120, window.innerHeight - m.clientY));
      $("#termPanel").style.height = `${h}px`;
    };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}
