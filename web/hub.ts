// Run Ask on the sanatana hub instead of the HP. The browser calls the hub's ask box with
// your own hub sign-in (cookie, CORS on /api/ask* only); the desk records the turn.
// Flow: Send → desk "prompt" with hub:{agent, model} → desk logs the prompt and replies
// hub_go → this calls hub /api/ask → hub_answer back to the desk (answer or error).
type Ev = { seq: number; sourceId: string; threadId: string; event: any };

let hubUrl = "";
let send: (m: unknown) => void = () => {};
const bar = document.createElement("div");
bar.id = "runOn";
bar.innerHTML = `<label>Run on <select name="where"><option value="hp">HP</option><option value="hub">Hub</option></select></label>`
  + `<select name="agent" hidden aria-label="Hub agent"></select><select name="model" hidden aria-label="Hub model"></select>`
  + `<a class="hubSignin" target="_blank" rel="noopener" hidden>Sign in to hub</a><span class="hubNote"></span>`;
const where = bar.querySelector<HTMLSelectElement>("[name=where]")!;
const agentSel = bar.querySelector<HTMLSelectElement>("[name=agent]")!;
const modelSel = bar.querySelector<HTMLSelectElement>("[name=model]")!;
const signin = bar.querySelector<HTMLAnchorElement>(".hubSignin")!;
const note = bar.querySelector<HTMLElement>(".hubNote")!;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

async function hubFetch(path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(hubUrl + path, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) { signin.hidden = false; throw new Error("not signed in to the hub (tap Sign in to hub, then try again)"); }
  if (!r.ok) throw new Error(explain(body?.detail) || `hub returned ${r.status}`);
  return body;
}

/** The hub relays refusals as a string or {error, why, what_would_change}. */
function explain(d: any): string {
  if (!d) return "";
  if (typeof d === "string") return d;
  return [d.error, d.why, d.what_would_change && `What would change: ${d.what_would_change}`].filter(Boolean).join("\n");
}

function fill(sel: HTMLSelectElement, rows: { v: string; t: string }[], want: string) {
  sel.replaceChildren(...rows.map((r) => Object.assign(document.createElement("option"), { value: r.v, textContent: r.t })));
  if (rows.some((r) => r.v === want)) sel.value = want;
}

async function loadModels() {
  const d = await hubFetch(`/api/ask/models?agent=${encodeURIComponent(agentSel.value)}`).catch(() => ({ models: [] }));
  const ms = (d.models ?? []).map((x: any) => ({ v: String(x), t: String(x) }));
  fill(modelSel, [{ v: "", t: `best available${ms.length ? ` (${ms[0].t})` : ""}` }, ...ms], lsGet("hubModel") ?? "");
  modelSel.hidden = false;
}

async function loadAgents() {
  note.textContent = "loading hub…";
  signin.hidden = true;
  try {
    const d = await hubFetch("/api/ask/agents");
    const rows = (d.agents ?? []).map((a: any) => ({ v: a.id, t: `${a.title || a.id}${a.locked ? " 🔒" : ""}` }));
    if (!rows.length) throw new Error("the hub listed no agents for you");
    fill(agentSel, rows, lsGet("hubAgent") ?? d.default);
    agentSel.hidden = false;
    note.textContent = "";
    await loadModels();
  } catch (e: any) {
    note.textContent = e.message;
  }
}

function showWhere() {
  const hub = where.value === "hub";
  agentSel.hidden = modelSel.hidden = !hub || !agentSel.options.length;
  if (!hub) { signin.hidden = true; note.textContent = ""; }
  else if (!agentSel.options.length) void loadAgents();
}

export function initHub(sendFn: (m: unknown) => void, form: HTMLElement) {
  send = sendFn;
  bar.hidden = true;
  form.prepend(bar);
  where.value = lsGet("runOn") === "hub" ? "hub" : "hp";
  where.addEventListener("change", () => { lsSet("runOn", where.value); showWhere(); });
  agentSel.addEventListener("change", () => { lsSet("hubAgent", agentSel.value); void loadModels(); });
  modelSel.addEventListener("change", () => lsSet("hubModel", modelSel.value));
}

/** From the desk's welcome: show the picker only when a hub is configured. */
export function setHubUrl(url?: string) {
  hubUrl = url ?? "";
  bar.hidden = !hubUrl;
  signin.href = hubUrl || "#";
  if (!hubUrl) where.value = "hp";
  showWhere();
}

/** What to attach to a prompt: hub:{agent, model} when running on the hub, else nothing. Slash commands stay on the HP. */
export function hubChoice(text: string): { agent: string; model: string } | undefined {
  if (!hubUrl || where.value !== "hub" || text.trimStart().startsWith("/")) return undefined;
  return { agent: agentSel.value || "expert", model: modelSel.value };
}

/** Earlier hub turns in this thread, as the hub's history: [{role, content}]. Claude (HP) turns are not sent. */
function history(evs: Ev[], sourceId: string, threadId: string) {
  const out: { role: string; content: string }[] = [];
  let answer: string[] | null = null;
  for (const e of evs) {
    if (e.sourceId !== sourceId || e.threadId !== threadId) continue;
    const ev = e.event;
    if (ev.kind === "prompt") {
      if (answer?.length) out.push({ role: "assistant", content: answer.join("").replace(/\n\n_— hub · [^\n]*_$/, "") });
      const m = /^hub:[^\[]*\[[^\]]*\]: ([\s\S]*)$/.exec(ev.text);
      answer = m ? [] : null;
      if (m) out.push({ role: "user", content: m[1] });
    } else if (ev.kind === "text" && answer) answer.push(ev.text);
  }
  // The last prompt is the one being asked now: it goes as `input`, not history.
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out.slice(-20);
}

/** The desk logged the prompt and wants the answer: ask the hub, report back. */
export async function onHubGo(m: any, evs: Ev[]) {
  const back = (r: { text?: string; error?: string; model?: string }) => send({ type: "hub_answer", sourceId: m.sourceId, threadId: m.threadId, ...r });
  try {
    const d = await hubFetch("/api/ask", { method: "POST", body: JSON.stringify({ input: m.text, agent: m.agent, model: m.model || undefined, history: history(evs, m.sourceId, m.threadId) }) });
    let text = String(d.output ?? "");
    const src = d.contract?.provenance;
    if (Array.isArray(src) && src.length) text += "\n\nSources:\n" + src.map((s: any) => `- ${[s.title, s.ref].filter(Boolean).join(" — ") || JSON.stringify(s)}`).join("\n");
    if (d.asking && d.missing?.length) text += `\n\n(the agent needs: ${d.missing.join(", ")})`;
    back({ text: text || "(empty answer)", model: d.model });
  } catch (e: any) {
    back({ error: e?.message ?? String(e) });
  }
}
