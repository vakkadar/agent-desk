import { test } from "node:test";
import assert from "node:assert/strict";
import { AskCards, answerSteps, parseCard } from "../src/ask-card.js";

// Screens captured from Claude Code 2.1.325 in a 120x40 pane.
const RULE = "─".repeat(120);
const single = `❯ Use the AskUserQuestion tool once to ask me which color I prefer.
${RULE}
 ☐ Color

Which color do you prefer?

❯ 1. Red
     Bold, warm, high energy.
  2. Green
     Calm, natural, balanced.
  3. Blue
     Cool, steady, professional.
  4. Type something.
${RULE}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

const multi = `${RULE}
←  ☐ Pets  ☐ Size  ✔ Submit  →

Pets?

❯ 1. [✔] Cat
         Independent, low-maintenance.
  2. [ ] Dog
         Active, needs walks and attention.
  3. [ ] Type something
     Next
${RULE}
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

const review = `←  ☒ Pets  ☒ Size  ✔ Submit  →

Review your answers

 ● Pets?
   → Cat
 ● Size?
   → Large

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;

const trust = ` Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

test("parseCard reads a single-choice question with descriptions, dropping 'Chat about this'", () => {
  const c = parseCard(single)!;
  assert.equal(c.question, "Which color do you prefer?");
  assert.equal(c.multi, false);
  assert.equal(c.tabs, undefined);
  assert.deepEqual(c.options.map((o) => [o.n, o.label, o.desc, !!o.other]), [
    [1, "Red", "Bold, warm, high energy.", false],
    [2, "Green", "Calm, natural, balanced.", false],
    [3, "Blue", "Cool, steady, professional.", false],
    [4, "Type something.", undefined, true],
  ]);
});

test("parseCard reads a multi-select with tabs and checked state", () => {
  const c = parseCard(multi)!;
  assert.equal(c.question, "Pets?");
  assert.equal(c.multi, true);
  assert.deepEqual(c.tabs, [{ label: "Pets", done: false }, { label: "Size", done: false }]);
  assert.deepEqual(c.options.map((o) => [o.label, o.checked]), [["Cat", true], ["Dog", false], ["Type something", false]]);
});

test("parseCard reads the review screen with a summary note", () => {
  const c = parseCard(review)!;
  assert.equal(c.question, "Ready to submit your answers?");
  assert.deepEqual(c.options.map((o) => o.label), ["Submit answers", "Cancel"]);
  assert.match(c.note!, /Pets\? → Cat · Size\? → Large/);
  assert.deepEqual(c.tabs?.map((t) => t.done), [true, true]);
});

test("parseCard ignores screens without a question: trust prompt, plain output, empty", () => {
  assert.equal(parseCard(trust), null);
  assert.equal(parseCard("● Done.\n❯ \n"), null);
  assert.equal(parseCard(""), null);
});

test("answerSteps: digit picks, typed answer is digit + text + enter, next is tab", () => {
  const c = parseCard(single)!;
  assert.deepEqual(answerSteps(c, { pick: 2 }), [{ keys: ["2"] }]);
  assert.deepEqual(answerSteps(c, { text: " Zed\nthe cat " }), [{ keys: ["4"] }, { text: "Zed the cat" }, { keys: ["enter"] }]);
  assert.throws(() => answerSteps(c, { pick: 9 }), /no option 9/);
  assert.throws(() => answerSteps(c, { next: true }), /no next step/);
  assert.deepEqual(answerSteps(parseCard(multi)!, { next: true }), [{ keys: ["tab"] }]);
  assert.throws(() => answerSteps(parseCard(review)!, { text: "x" }), /no typed answer/);
});

test("AskCards reports a card when it appears and null when it goes; answer types into the pane", async () => {
  let screen = single;
  const typed: unknown[] = [];
  const pairs: any = {
    list: () => [{ sourceId: "s1", tabs: { "code-1": {} } }],
    screenOf: async (_s: string, _t: string, role: string) => (role === "builder" ? screen : ""),
    typeInto: async (_s: string, _t: string, role: string, step: unknown) => { typed.push([role, step]); },
  };
  const seen: any[] = [];
  const cards = new AskCards(pairs, (e) => seen.push(e));
  await cards.tick();
  await cards.tick(); // unchanged: not reported again
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, "builder");
  assert.equal(seen[0].card.question, "Which color do you prefer?");
  assert.equal(cards.current().length, 1);

  await cards.answer("s1", "code-1", "builder", "Which color do you prefer?", { pick: 3 });
  assert.deepEqual(typed, [["builder", { keys: ["3"] }]]);
  await assert.rejects(cards.answer("s1", "code-1", "builder", "Another question?", { pick: 1 }), /no longer showing/);

  screen = "● Blue it is.\n❯ ";
  await cards.tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].card, null);
  assert.equal(cards.current().length, 0);
});
