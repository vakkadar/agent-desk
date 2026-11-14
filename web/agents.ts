// Settings → Agents: which coding agents this desk uses, and which one builds / reviews in a pair.
// Saved on the server in <data>/agents.json; new pair tabs pick it up, running panes keep theirs.
const dlg = document.querySelector<HTMLDialogElement>("#agents")!;
const body = document.querySelector<HTMLElement>("#agentsBody")!;
let send: (m: unknown) => void = () => {};
let canSave = () => false;

interface Agent { id: string; label: string; installed: boolean }
interface Settings { enabled: string[]; builder: string; reviewer: string }

export function initAgents(sendFn: (m: unknown) => void, canSaveFn: () => boolean) {
  send = sendFn;
  canSave = canSaveFn;
  document.querySelector("#agentsClose")!.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}

export function showAgents() {
  body.textContent = "Loading…";
  dlg.showModal();
  send({ type: "agents" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export function renderAgents(m: { agents: Agent[]; settings: Settings; saved?: boolean }) {
  const s: Settings = { ...m.settings, enabled: [...m.settings.enabled] };
  const ro = !canSave();
  const pick = (role: "builder" | "reviewer") => {
    const sel = el("select", { disabled: ro, ariaLabel: role });
    const fill = () => {
      sel.replaceChildren(...s.enabled.map((id) => el("option", { value: id, selected: s[role] === id }, m.agents.find((a) => a.id === id)?.label ?? id)));
      if (!s.enabled.includes(s[role])) s[role] = s.enabled[0];
    };
    sel.onchange = () => { s[role] = sel.value; };
    return { sel, fill };
  };
  const b = pick("builder"), r = pick("reviewer");
  const rows = m.agents.map((a) => {
    const cb = el("input", { type: "checkbox", checked: s.enabled.includes(a.id), disabled: ro || !a.installed });
    cb.onchange = () => {
      s.enabled = cb.checked ? [...s.enabled, a.id] : s.enabled.filter((x) => x !== a.id);
      if (!s.enabled.length) { cb.checked = true; s.enabled = [a.id]; }
      b.fill(); r.fill();
    };
    return el("label", { className: "srow" }, el("span", {}, el("b", {}, a.label), el("small", {}, a.installed ? "installed" : "not installed on this machine")), cb);
  });
  b.fill(); r.fill();
  const msg = el("small", {}, m.saved ? "Saved. New pair tabs use it; open panes keep their agents." : ro ? "Read-only connection." : "");
  const save = el("button", { type: "button", disabled: ro }, "Save");
  save.onclick = () => send({ type: "agents_set", settings: s });
  body.replaceChildren(
    el("small", {}, "Agents this desk may use. A pair runs two: a builder and a reviewer (the same agent twice is fine)."),
    ...rows,
    el("div", { className: "srow" }, el("span", {}, el("b", {}, "Builder")), b.sel),
    el("div", { className: "srow" }, el("span", {}, el("b", {}, "Reviewer")), r.sel),
    el("div", { className: "srow" }, msg, save),
  );
}
