// Sessions dialog: named herdr sessions (agent-desk-session create …). Open / Close, PIN per session.
// PINs are kept in this browser (localStorage) after the first successful use, and sent with each action.
const dlg = document.querySelector<HTMLDialogElement>("#hsessions")!;
const body = document.querySelector<HTMLElement>("#hsBody")!;
const pinForm = document.querySelector<HTMLFormElement>("#hsPin")!;
const pinInput = pinForm.querySelector("input")!;
const pinLabel = pinForm.querySelector("label")!;
let send: (m: unknown) => void = () => {};
let canAct = () => false;
let rows: any[] = [];
let asking: { name: string; then?: () => void } | null = null;
let pending: string | null = null; // session being opened: a PIN error retries the open, not a prompt

const key = (name: string) => `pin:${name}`;
export function pinFor(name: string): string | undefined {
  try { return localStorage.getItem(key(name)) ?? undefined; } catch { return undefined; }
}
function savePin(name: string, pin: string | null) {
  try { pin ? localStorage.setItem(key(name), pin) : localStorage.removeItem(key(name)); } catch { /* private mode: asked again next time */ }
}

export function initHSessions(sendFn: (m: unknown) => void, canActFn: () => boolean) {
  send = sendFn;
  canAct = canActFn;
  document.querySelector("#hsClose")!.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  pinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!asking || !pinInput.value) return;
    savePin(asking.name, pinInput.value);
    const then = asking.then;
    hidePin();
    then?.();
  });
}

function hidePin() {
  asking = null;
  pinInput.value = "";
  pinForm.hidden = true;
}

function askPin(name: string, why: string, then?: () => void) {
  if (!dlg.open) dlg.showModal();
  asking = { name, then };
  pinLabel.textContent = `${why} — PIN for ${name}`;
  pinForm.hidden = false;
  pinInput.focus();
}

export function showHSessions() {
  hidePin();
  pending = null;
  if (!dlg.open) dlg.showModal();
  body.textContent = "Loading…";
  send({ type: "hsessions" });
}

function act(type: "hsession_open" | "hsession_close", name: string) {
  const r = rows.find((x) => x.name === name);
  if (r?.pinned && !pinFor(name)) return askPin(name, type === "hsession_open" ? "Open" : "Close", () => act(type, name));
  send({ type, name, pin: pinFor(name) });
  body.querySelectorAll("button").forEach((b) => (b.disabled = true));
}

/** "attach: <name>" typed in the box. */
export function attachByName(name: string) {
  showHSessions();
  pending = name;
  // The list may not be loaded yet: ask the server directly; a PIN error comes back through onHSessionError.
  send({ type: "hsession_open", name, pin: pinFor(name) });
}

/** Server error about a session PIN: forget the stored one, ask, then retry (actions) or tell to resend (prompts). */
export function onHSessionError(msg: string, retryPrompt?: () => void): boolean {
  const m = /^(PIN required|wrong PIN) for session (\S+)$/.exec(msg);
  if (!m) return false;
  const name = m[2];
  savePin(name, null);
  const opening = pending === name;
  askPin(name, m[1] === "wrong PIN" ? "Wrong PIN, try again" : "PIN needed", () => {
    if (opening) act("hsession_open", name);
    else { dlg.close(); retryPrompt?.(); }
  });
  return true;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "");

export function renderHSessions(list: any[]) {
  rows = list;
  if (!rows.length) return void (body.textContent = "No sessions. Create one on the host: agent-desk-session create <name> [folder] --pin");
  body.replaceChildren(...rows.map((r) => {
    const d = document.createElement("div");
    d.className = "srow";
    const t = document.createElement("span");
    t.innerHTML = "<b></b><small></small>";
    const live = r.running === undefined ? "" : r.running ? " · running" : " · stopped";
    t.querySelector("b")!.textContent = `${r.pinned ? "🔒 " : ""}${r.name}`;
    t.querySelector("small")!.textContent = `${r.state}${live} · ${r.dir} · ${when(r.updatedAt)}`;
    const b = document.createElement("button");
    b.type = "button";
    const opening = r.state !== "open" || !r.running;
    b.textContent = opening ? "Open" : "Close";
    b.disabled = !canAct();
    b.onclick = () => {
      pending = opening ? r.name : null;
      act(opening ? "hsession_open" : "hsession_close", r.name);
    };
    d.append(t, b);
    return d;
  }));
}
