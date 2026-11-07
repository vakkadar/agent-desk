import { test } from "node:test";
import assert from "node:assert/strict";
import { listPanes, pickLive, type LivePane } from "../src/live.js";
import { parseExisting } from "../src/general.js";

const pane = (paneId: string, title: string, status: LivePane["status"] = "idle"): LivePane =>
  ({ herdrSession: "default", paneId, status, title, cwd: "/p", sessionId: "s-" + paneId });

test("pickLive: none / one / many, and c: picks by pane id or title", () => {
  assert.equal(pickLive([]).kind, "none");
  const a = pane("w3:p1", "Saradha discussion history");
  const b = pane("w9:p1", "Transit dates", "working");
  assert.deepEqual(pickLive([a]), { kind: "one", pane: a });
  assert.equal(pickLive([a, b]).kind, "many");
  assert.deepEqual(pickLive([a, b], "w9"), { kind: "one", pane: b });
  assert.deepEqual(pickLive([a, b], "w3:p1"), { kind: "one", pane: a });
  assert.deepEqual(pickLive([a, b], "saradha"), { kind: "one", pane: a });
  assert.equal(pickLive([a, b], "nothing").kind, "none");
  assert.match(listPanes([a, b]), /c: w3 <message>.*Saradha[\s\S]*c: w9 <message>.*working/);
});

test("parseExisting: one-line c: with a herdr pane id", () => {
  assert.deepEqual(parseExisting("c: w3 how is work"), { query: "w3", rest: "how is work" });
  assert.deepEqual(parseExisting("c: wA:p1 hi"), { query: "wA:p1", rest: "hi" });
});
