// Schedules list: name, next run, last run, "Run now" (desk.toml [[schedule]]).
const dlg = document.querySelector<HTMLDialogElement>("#schedules")!;
const body = document.querySelector<HTMLElement>("#schedBody")!;
let send: (m: unknown) => void = () => {};
let canRun = () => false;

export function initSchedules(sendFn: (m: unknown) => void, canRunFn: () => boolean) {
  send = sendFn;
  canRun = canRunFn;
  document.querySelector("#schedClose")!.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
}

export function showSchedules() {
  body.textContent = "Loading…";
  dlg.showModal();
  send({ type: "schedules" });
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never");

export function renderSchedules(rows: any[]) {
  if (!rows.length) return void (body.textContent = "No schedules. Add [[schedule]] to desk.toml.");
  body.replaceChildren(...rows.map((r) => {
    const d = document.createElement("div");
    d.className = "srow";
    const t = document.createElement("span");
    t.innerHTML = "<b></b><small></small>";
    t.querySelector("b")!.textContent = r.name + (r.running ? " (running)" : "");
    t.querySelector("small")!.textContent = `${r.source} · next ${when(r.next)} · last ${when(r.last)}`;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Run now";
    b.disabled = !canRun() || r.running;
    b.onclick = () => send({ type: "schedule_run", name: r.name });
    d.append(t, b);
    return d;
  }));
}
