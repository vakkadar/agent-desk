// Ask targets: places a question in Ask can run besides Claude on this host.
//
//   [[ask_target]]
//   id = "hub"                    # letters, digits, - _ ; shown in the prompt tag
//   label = "Sanatana hub"        # optional, for the Run on picker
//   kind = "sanatana-hub" | "browser" | "openai"
//   url = "https://…"
//
// Two ways a target is reached:
// - browser kinds (sanatana-hub, browser): the page calls the service with the reader's own
//   sign-in there (cookies, CORS); no secret on the desk. The desk logs the turn and waits
//   for the page's reply.
// - server kinds (openai): the desk calls an OpenAI-compatible API (OpenRouter, Ollama,
//   LM Studio, vLLM, …) with a key from its env file (key_env). The key never reaches a page.
import type { Msg } from "./ask-history.js";

export type TargetKind = "sanatana-hub" | "browser" | "openai";
export const BROWSER_KINDS: TargetKind[] = ["sanatana-hub", "browser"];

/** How a generic browser target is called. JSON field names; `*_field` may be dotted paths into the reply. */
export interface BrowserSpec {
  askPath: string; // POST, JSON body
  inputField: string;
  historyField?: string; // [{role, content}] earlier turns on this target
  modelField?: string; // request field for the chosen model
  outputField: string; // reply field holding the answer text
  replyModelField?: string; // reply field naming the model that answered
  modelsPath?: string; // GET, optional: a list of models to offer
  modelsField?: string; // reply field holding that list (strings or {id})
  credentials: "include" | "omit";
}

export interface AskTarget {
  id: string;
  label: string;
  kind: TargetKind;
  url: string;
  // openai
  keyEnv?: string;
  models?: string[]; // offered in the picker; empty: asked of GET {url}/models
  defaultModel?: string;
  system?: string; // optional system prompt
  // browser
  browser?: BrowserSpec;
}

/** What the page sees: never key_env or the system prompt. */
export type PublicTarget = Pick<AskTarget, "id" | "label" | "kind" | "url" | "models" | "defaultModel" | "browser"> & { browserSide: boolean };

const ID = /^[A-Za-z0-9_-]{1,30}$/;

function str(v: unknown, what: string, fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v.trim();
}

/** [[ask_target]] entries, plus the older `[hub] url` as a sanatana-hub target. */
export function parseTargets(raw: any): AskTarget[] {
  const list: any[] = Array.isArray(raw.ask_target) ? [...raw.ask_target] : [];
  if (typeof raw.hub?.url === "string" && !list.some((t) => t?.kind === "sanatana-hub")) list.push({ id: "hub", kind: "sanatana-hub", url: raw.hub.url });
  const out: AskTarget[] = [];
  for (const [i, t] of list.entries()) {
    const where = `ask_target #${i + 1}`;
    const id = str(t.id, `${where} id`);
    if (!ID.test(id) || id === "local") throw new Error(`${where}: id "${id}" must be letters, digits, - or _ (and not "local")`);
    if (out.some((o) => o.id === id)) throw new Error(`${where}: duplicate id "${id}"`);
    const kind = t.kind as TargetKind;
    if (!["sanatana-hub", "browser", "openai"].includes(kind)) throw new Error(`${where}: kind must be sanatana-hub, browser or openai`);
    const url = str(t.url, `${where} url`).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) throw new Error(`${where}: url must start with http:// or https://`);
    const base: AskTarget = { id, kind, url, label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : id };
    if (kind === "openai") {
      base.keyEnv = t.key_env === undefined ? undefined : str(t.key_env, `${where} key_env`);
      base.models = Array.isArray(t.models) ? t.models.map(String) : undefined;
      base.defaultModel = t.default_model === undefined ? undefined : str(t.default_model, `${where} default_model`);
      base.system = typeof t.system === "string" ? t.system : undefined;
    }
    if (kind === "browser") {
      base.browser = {
        askPath: str(t.ask_path, `${where} ask_path`),
        inputField: str(t.input_field, `${where} input_field`, "input"),
        historyField: t.history_field === undefined ? undefined : str(t.history_field, `${where} history_field`),
        modelField: t.model_field === undefined ? undefined : str(t.model_field, `${where} model_field`),
        outputField: str(t.output_field, `${where} output_field`, "output"),
        replyModelField: t.reply_model_field === undefined ? undefined : str(t.reply_model_field, `${where} reply_model_field`),
        modelsPath: t.models_path === undefined ? undefined : str(t.models_path, `${where} models_path`),
        modelsField: t.models_field === undefined ? undefined : str(t.models_field, `${where} models_field`),
        credentials: t.credentials === "omit" ? "omit" : "include",
      };
      base.models = Array.isArray(t.models) ? t.models.map(String) : undefined;
    }
    out.push(base);
  }
  return out;
}

export const publicTarget = (t: AskTarget): PublicTarget => ({
  id: t.id, label: t.label, kind: t.kind, url: t.url, models: t.models, defaultModel: t.defaultModel, browser: t.browser,
  browserSide: BROWSER_KINDS.includes(t.kind),
});

// ---- openai-compatible (server side) ----

type Fetch = typeof fetch;

function headers(t: AskTarget, env: NodeJS.ProcessEnv): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t.keyEnv) {
    const k = env[t.keyEnv];
    if (!k) throw new Error(`${t.id}: ${t.keyEnv} is not set in the desk's env file`);
    h.Authorization = `Bearer ${k}`;
  }
  return h;
}

async function errorText(r: Response): Promise<string> {
  const body = await r.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    return String(j?.error?.message ?? j?.error ?? j?.message ?? body).slice(0, 300);
  } catch {
    return body.slice(0, 300) || r.statusText;
  }
}

export async function openaiModels(t: AskTarget, env = process.env, f: Fetch = fetch): Promise<string[]> {
  if (t.models?.length) return t.models;
  const r = await f(`${t.url}/models`, { headers: headers(t, env), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${t.id}: listing models failed (${r.status}: ${await errorText(r)})`);
  const j: any = await r.json();
  return (j?.data ?? j?.models ?? []).map((m: any) => String(m?.id ?? m?.name ?? m)).filter(Boolean).sort();
}

export async function openaiAsk(
  t: AskTarget, o: { input: string; history: Msg[]; model?: string; signal?: AbortSignal },
  env = process.env, f: Fetch = fetch,
): Promise<{ text: string; model: string; tokensIn?: number; tokensOut?: number }> {
  const model = o.model || t.defaultModel || t.models?.[0];
  if (!model) throw new Error(`${t.id}: no model chosen (set default_model or models in desk.toml)`);
  const messages = [...(t.system ? [{ role: "system", content: t.system }] : []), ...o.history, { role: "user", content: o.input }];
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
  const r = await f(`${t.url}/chat/completions`, { method: "POST", headers: headers(t, env), body: JSON.stringify({ model, messages }), signal });
  if (!r.ok) throw new Error(`${t.id}: ${r.status} ${await errorText(r)}`);
  const j: any = await r.json();
  const text = String(j?.choices?.[0]?.message?.content ?? "");
  return { text, model: String(j?.model ?? model), tokensIn: j?.usage?.prompt_tokens, tokensOut: j?.usage?.completion_tokens };
}
