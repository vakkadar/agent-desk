// Run on: where a question in Ask runs. "This host" is Claude on the desk's machine; the
// rest come from [[ask_target]] in desk.toml (see src/ask-targets.ts).
// Browser-side targets (sanatana-hub, browser) are called from this page with your own
// sign-in there; the desk logs the turn and waits for our target_answer. Server-side ones
// (openai) are called by the desk; this page only lists their models.
import { targetHistory } from "../src/ask-history.js";
import type { PublicTarget } from "../src/ask-targets.js";

type Ev = { seq: number; sourceId: string; threadId: string; event: any };

let targets: PublicTarget[] = [];
let send: (m: unknown) => void = () => {};
const bar = document.createElement("div");
bar.id = "runOn";
bar.innerHTML = `<label>Run on <select name="where"></select></label>`
  + `<select name="agent" hidden aria-label="Agent"></select><select name="model" hidden aria-label="Model"></select>`
  + `<a class="signin" target="_blank" rel="noopener" hidden>Sign in</a><span class="note"></span>`;
const where = bar.querySelector<HTMLSelectElement>("[name=where]")!;
const agentSel = bar.querySelector<HTMLSelectElement>("[name=agent]")!;
const modelSel = bar.querySelector<HTMLSelectElement>("[name=model]")!;
const signin = bar.querySelector<HTMLAnchorElement>(".signin")!;
const note = bar.querySelector<HTMLElement>(".note")!;
const loaded = new Set<string>(); // targets whose pickers are filled

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const current = () => targets.find((t) => t.id === where.value);

/** Dotted path into a JSON reply ("result.text"). */
const pick = (o: any, path?: string) => (path ? path.split(".").reduce((v, k) => (v == null ? v : v[k]), o) : undefined);

/** Refusals as a string, {detail}, or the hub's {error, why, what_would_change}. */
function explain(d: any): string {
  d = d?.detail ?? d?.error ?? d;
  if (!d) return "";
  if (typeof d === "string") return d;
  if (d.message) return String(d.message);
  return [d.error, d.why, d.what_would_change && `What would change: ${d.what_would_change}`].filter(Boolean).join("\n");
}

async function call(t: PublicTarget, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(t.url + path, {
    ...init,
    credentials: t.browser?.credentials ?? "include",
    headers: init.body ? { "Content-Type": "application/json" } : {},
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || (r.status === 403 && t.kind === "browser")) {
    signin.href = t.url;
    signin.textContent = `Sign in to ${t.label}`;
    signin.hidden = false;
    throw new Error(`not signed in to ${t.label} (tap Sign in, then try again)`);
  }
  if (!r.ok) throw new Error(explain(body) || `${t.label} returned ${r.status}`);
  return body;
}

function fill(sel: HTMLSelectElement, rows: { v: string; t: string }[], want: string | null) {
  sel.replaceChildren(...rows.map((r) => Object.assign(document.createElement("option"), { value: r.v, textContent: r.t })));
  if (want != null && rows.some((r) => r.v === want)) sel.value = want;
  sel.hidden = rows.length < 2;
}

function fillModels(t: PublicTarget, models: string[], def?: string) {
  const rows = models.map((m) => ({ v: m, t: m }));
  const first = def || models[0];
  fill(modelSel, [{ v: "", t: first ? `default (${first})` : "default model" }, ...rows], lsGet(`model:${t.id}`));
}

async function load(t: PublicTarget) {
  note.textContent = `loading ${t.label}…`;
  signin.hidden = true;
  agentSel.hidden = modelSel.hidden = true;
  try {
    if (t.kind === "sanatana-hub") {
      const d = await call(t, "/api/ask/agents");
      const rows = (d.agents ?? []).map((a: any) => ({ v: a.id, t: `${a.title || a.id}${a.locked ? " 🔒" : ""}` }));
      if (!rows.length) throw new Error(`${t.label} lists no agents for you`);
      fill(agentSel, rows, lsGet(`agent:${t.id}`) ?? d.default);
      agentSel.hidden = false;
      const md = await call(t, `/api/ask/models?agent=${encodeURIComponent(agentSel.value)}`).catch(() => ({ models: [] }));
      fillModels(t, (md.models ?? []).map(String), md.default);
    } else if (t.kind === "browser") {
      const ms = t.models?.length ? t.models
        : t.browser?.modelsPath ? ((pick(await call(t, t.browser.modelsPath), t.browser.modelsField) ?? []) as any[]).map((m) => String(m?.id ?? m)) : [];
      fillModels(t, ms, t.defaultModel);
    } else {
      send({ type: "target_models", target: t.id }); // answer arrives as target_models
      return;
    }
    loaded.add(t.id);
    note.textContent = "";
  } catch (e: any) {
    note.textContent = e.message;
  }
}

/** Server-side target's models (reply to target_models). */
export function onTargetModels(m: any) {
  const t = targets.find((x) => x.id === m.target);
  if (!t || where.value !== t.id) return;
  fillModels(t, m.models ?? [], m.default);
  loaded.add(t.id);
  note.textContent = "";
}

function showWhere() {
  lsSet("runOn", where.value);
  const t = current();
  signin.hidden = true;
  note.textContent = "";
  agentSel.hidden = modelSel.hidden = true;
  agentSel.replaceChildren();
  if (t) { loaded.delete(t.id); void load(t); }
}

export function initTargets(sendFn: (m: unknown) => void, form: HTMLElement) {
  send = sendFn;
  bar.hidden = true;
  form.prepend(bar);
  where.addEventListener("change", showWhere);
  agentSel.addEventListener("change", () => {
    const t = current();
    if (!t) return;
    lsSet(`agent:${t.id}`, agentSel.value);
    void call(t, `/api/ask/models?agent=${encodeURIComponent(agentSel.value)}`).then((md) => fillModels(t, (md.models ?? []).map(String), md.default), () => {});
  });
  modelSel.addEventListener("change", () => { const t = current(); if (t) lsSet(`model:${t.id}`, modelSel.value); });
}

/** From the desk's welcome: the picker shows only when there is a target besides this host. */
export function setTargets(list: PublicTarget[] = []) {
  targets = list;
  const want = lsGet("runOn");
  where.replaceChildren(
    Object.assign(document.createElement("option"), { value: "local", textContent: "This host" }),
    ...targets.map((t) => Object.assign(document.createElement("option"), { value: t.id, textContent: t.label })),
  );
  where.value = targets.some((t) => t.id === want) ? want! : "local";
  bar.hidden = !targets.length;
  showWhere();
}

/** Attached to a prompt: the chosen target, or nothing for this host. Slash commands stay on this host. */
export function targetChoice(text: string): { id: string; agent?: string; model?: string } | undefined {
  const t = current();
  if (!t || text.trimStart().startsWith("/")) return undefined;
  return { id: t.id, agent: agentSel.value || undefined, model: modelSel.value || undefined };
}

/** The desk logged the prompt and wants the answer from a browser-side target. */
export async function onTargetGo(m: any, evs: Ev[]) {
  const back = (r: { text?: string; error?: string; model?: string }) => send({ type: "target_answer", sourceId: m.sourceId, threadId: m.threadId, ...r });
  const t = targets.find((x) => x.id === m.target);
  if (!t) return back({ error: `this page doesn't know target ${m.target}; reload it` });
  const history = targetHistory(evs, m.sourceId, m.threadId, t.id);
  try {
    if (t.kind === "sanatana-hub") {
      const d = await call(t, "/api/ask", { method: "POST", body: JSON.stringify({ input: m.text, agent: m.agent, model: m.model || undefined, history }) });
      let text = String(d.output ?? "");
      const src = d.contract?.provenance;
      if (Array.isArray(src) && src.length) text += "\n\nSources:\n" + src.map((s: any) => `- ${[s.title, s.ref].filter(Boolean).join(" — ") || JSON.stringify(s)}`).join("\n");
      if (d.asking && d.missing?.length) text += `\n\n(the agent needs: ${d.missing.join(", ")})`;
      return back({ text: text || "(empty answer)", model: d.model });
    }
    const b = t.browser!;
    const body: Record<string, unknown> = { [b.inputField]: m.text };
    if (b.historyField) body[b.historyField] = history;
    if (b.modelField && m.model) body[b.modelField] = m.model;
    const d = await call(t, b.askPath, { method: "POST", body: JSON.stringify(body) });
    const out = pick(d, b.outputField);
    back({ text: out == null || out === "" ? "(empty answer)" : String(out), model: b.replyModelField ? String(pick(d, b.replyModelField) ?? "") || undefined : undefined });
  } catch (e: any) {
    back({ error: e?.message ?? String(e) });
  }
}
