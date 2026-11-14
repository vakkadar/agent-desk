// Model per activity ([model] in desk.toml): which Claude model a turn or a pair pane runs with.
//
//   [model]
//   design   = "opus"      # design threads
//   code     = "sonnet"    # code threads (and their builder pane)
//   ask      = "sonnet"    # project Ask and General
//   schedule = "haiku"     # scheduled prompts ([[schedule]] may set its own model = "...")
//   lead     = "sonnet"    # a project's lead builder pane
//   reviewer = "opus"      # every reviewer pane running Claude
//   general  = "haiku"     # a source id: wins over its activity
//
// Unset keys leave the choice to Claude (its own default), except pair panes, which keep
// their old defaults: builder sonnet, reviewer opus. Codex and opencode use their own config.
import type { Mode } from "./types.js";
import type { PairModels } from "./pair.js";

export type ModelMap = Record<string, string>;

const OK = /^[A-Za-z0-9._:\[\]-]{1,80}$/;

/** Keep only usable string entries; a bad one is skipped with a warning, never stops the desk. */
export function parseModels(raw: unknown): ModelMap {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn("[model] must be a table of key = \"model\"; ignored");
    return {};
  }
  const out: ModelMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && OK.test(v.trim())) out[k] = v.trim();
    else console.warn(`[model] ${k}: not a model name; ignored`);
  }
  return out;
}

export const validModel = (m: unknown): m is string => typeof m === "string" && OK.test(m);

/** Model for a headless turn: schedule's own > source id > "schedule" (scheduled runs) > thread mode. */
export function turnModel(map: ModelMap, o: { sourceId: string; mode: Mode; scheduled?: boolean; own?: string }): string | undefined {
  return o.own || map[o.sourceId] || (o.scheduled ? map.schedule : undefined) || map[o.mode] || undefined;
}

/** Models for a pair tab: "lead" or a thread of `mode`. */
export function pairModels(map: ModelMap, sourceId: string, tab: string, mode?: Mode): PairModels {
  const builder = map[sourceId] || (tab === "lead" ? map.lead : mode && map[mode]) || "sonnet";
  return { builder, reviewer: map.reviewer || "opus" };
}
