// Health panel (RH-7): read-only view over /healthz.
const dlg = document.querySelector<HTMLDialogElement>("#health")!;
const body = document.querySelector<HTMLElement>("#healthBody")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const LABEL: Record<string, string> = { mux: "herdr", agent: "agent", git: "last git push", disk: "disk", auth: "auth", usageLimit: "usage limit" };

function fmtUp(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + "d " : ""}${h}h ${m}m`;
}

async function load() {
  body.textContent = "Loading…";
  try {
    const j = await (await fetch("/healthz")).json();
    const rows: string[] = [`<div class="hrow"><span class="hdot ok"></span><span class="hname">uptime</span><span class="hdet">${esc(fmtUp(j.uptime))}</span></div>`];
    for (const [k, v] of Object.entries<any>(j.checks ?? {})) {
      const lvl = v?.level ?? "unknown";
      rows.push(`<div class="hrow"><span class="hdot ${esc(lvl)}"></span><span class="hname">${esc(LABEL[k] ?? k)}</span><span class="hdet">${esc(v?.detail ?? lvl)}</span></div>`);
    }
    body.innerHTML = rows.join("");
  } catch (e) {
    body.textContent = "Health unavailable: " + e;
  }
}

document.querySelector("#healthBtn")!.addEventListener("click", () => { dlg.showModal(); void load(); });
document.querySelector("#healthClose")!.addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
