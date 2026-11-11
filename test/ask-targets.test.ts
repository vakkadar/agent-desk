import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiAsk, openaiModels, parseTargets, publicTarget } from "../src/ask-targets.js";
import { promptTag, signature, targetHistory } from "../src/ask-history.js";
import { featuresOf, needFeature, parseProfiles, profileFor } from "../src/profiles.js";

test("profiles: default everyday, per-email override, bad names refused", () => {
  const p = parseProfiles({ profile_by_email: { "Me@X.com": "developer" } });
  assert.equal(p.profile, "everyday");
  assert.equal(profileFor(p, "me@x.com"), "developer");
  assert.equal(profileFor(p, "guest@x.com"), "everyday");
  assert.equal(profileFor(p, undefined), "everyday");
  assert.ok(featuresOf("developer").has("terminal"));
  assert.equal(featuresOf("everyday").size, 0);
  assert.throws(() => needFeature(featuresOf("everyday"), "code"), /not part of your profile/);
  assert.throws(() => parseProfiles({ profile: "superuser" }), /profile must be one of/);
  const d = parseProfiles({ profile: "developer", profile_by_email: { "me@x.com": "developer", "g@x.com": "everyday" } });
  assert.equal(profileFor(d, undefined), "developer"); // localhost keeps the desk default
  assert.equal(profileFor(d, "new@x.com", true), "everyday"); // unlisted tunnel guest
  assert.equal(profileFor(d, "me@x.com", true), "developer");
  assert.equal(d.guestAsk, false);
  assert.equal(parseProfiles({ guest_ask: true }).guestAsk, true);
  assert.throws(() => parseProfiles({ guest_profile: "x" }), /guest_profile must be one of/);
  assert.throws(() => parseProfiles({ profile_by_email: { a: "root" } }), /must be one of/);
});

test("targets: parsed and checked; [hub] url still works; page never sees key_env or system", () => {
  const t = parseTargets({
    hub: { url: "https://hub.example/" },
    ask_target: [
      { id: "or", kind: "openai", url: "https://openrouter.ai/api/v1/", key_env: "OR_KEY", default_model: "m1", system: "secret prompt" },
      { id: "gen", kind: "browser", url: "https://x.example", ask_path: "/ask", output_field: "data.text" },
    ],
  });
  assert.deepEqual(t.map((x) => [x.id, x.kind, x.url]), [["or", "openai", "https://openrouter.ai/api/v1"], ["gen", "browser", "https://x.example"], ["hub", "sanatana-hub", "https://hub.example"]]);
  assert.equal(t[1].browser!.inputField, "input");
  const pub = publicTarget(t[0]) as any;
  assert.equal(pub.keyEnv, undefined);
  assert.equal(pub.system, undefined);
  assert.equal(pub.browserSide, false);
  assert.equal((publicTarget(t[2]) as any).browserSide, true);
  assert.throws(() => parseTargets({ ask_target: [{ id: "local", kind: "openai", url: "https://a" }] }), /not "local"/);
  assert.throws(() => parseTargets({ ask_target: [{ id: "a", kind: "ftp", url: "https://a" }] }), /kind must be/);
  assert.throws(() => parseTargets({ ask_target: [{ id: "a", kind: "openai", url: "ftp://a" }] }), /url must start/);
  assert.throws(() => parseTargets({ ask_target: [{ id: "a", kind: "openai", url: "https://a" }, { id: "a", kind: "openai", url: "https://b" }] }), /duplicate/);
  assert.throws(() => parseTargets({ ask_target: [{ id: "a", kind: "browser", url: "https://a" }] }), /ask_path/);
});

test("history: only this target's earlier turns, signature stripped, current question left out", () => {
  const ev = (threadId: string, event: any) => ({ sourceId: "s", threadId, event });
  const evs = [
    ev("q-1", { kind: "prompt", text: "browser[q-1]: local question" }),
    ev("q-1", { kind: "text", text: "local answer" }),
    ev("q-1", { kind: "prompt", text: promptTag("or", "m1", "q-1", "first") }),
    ev("q-1", { kind: "text", text: "one" + signature("OpenRouter", "m1") }),
    ev("q-1", { kind: "prompt", text: promptTag("hub", "expert", "q-1", "other target") }),
    ev("q-1", { kind: "text", text: "hub answer" }),
    ev("q-1", { kind: "prompt", text: promptTag("or", "", "q-1", "failed one") }),
    ev("q-1", { kind: "done", outcome: "error" }),
    ev("q-2", { kind: "prompt", text: promptTag("or", "", "q-2", "elsewhere") }),
    ev("q-1", { kind: "prompt", text: promptTag("or", "m1", "q-1", "now") }),
  ];
  assert.deepEqual(targetHistory(evs, "s", "q-1", "or"), [{ role: "user", content: "first" }, { role: "assistant", content: "one" }]);
});

test("openai: models from config or GET /models; ask sends history and key, reads the answer", async () => {
  const [t] = parseTargets({ ask_target: [{ id: "or", kind: "openai", url: "https://api.example/v1", key_env: "K", system: "be brief" }] });
  const calls: any[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
    return new Response(JSON.stringify({ model: "a-2", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  }) as typeof fetch;
  assert.deepEqual(await openaiModels(t, { K: "sk" }, f), ["a", "b"]);
  const r = await openaiAsk(t, { input: "q", history: [{ role: "user", content: "p" }, { role: "assistant", content: "r" }], model: "a" }, { K: "sk" }, f);
  assert.deepEqual(r, { text: "hi", model: "a-2", tokensIn: 3, tokensOut: 1 });
  const sent = JSON.parse(calls[1].init.body);
  assert.equal(calls[1].url, "https://api.example/v1/chat/completions");
  assert.equal(calls[1].init.headers.Authorization, "Bearer sk");
  assert.deepEqual(sent.messages.map((m: any) => m.role), ["system", "user", "assistant", "user"]);
  await assert.rejects(openaiAsk(t, { input: "q", history: [], model: "a" }, {}, f), /K is not set/);
  await assert.rejects(openaiAsk(t, { input: "q", history: [] }, { K: "sk" }, f), /no model chosen/);
  const bad = (async () => new Response(JSON.stringify({ error: { message: "quota spent" } }), { status: 429 })) as unknown as typeof fetch;
  await assert.rejects(openaiAsk(t, { input: "q", history: [], model: "a" }, { K: "sk" }, bad), /429 quota spent/);
});
