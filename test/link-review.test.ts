import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, fetchMaterial, htmlText, parseReviewPrefix, prepareReview, rawUrl } from "../src/link-review.js";

test("parseReviewPrefix takes the link and the rest", () => {
  assert.deepEqual(parseReviewPrefix("review: https://x.org/a/b/pull/3 focus on auth\nand tests"), { url: "https://x.org/a/b/pull/3", rest: "focus on auth\nand tests" });
  assert.equal(parseReviewPrefix("review this please"), null);
  assert.equal(parseReviewPrefix("review: ftp://x"), null);
});

test("classify knows GitHub, GitLab, Gitea and docs", () => {
  assert.deepEqual(classify("https://github.com/o/r/pull/12/files#diff"), { kind: "github-pr", url: "https://github.com/o/r/pull/12", host: "github.com", repo: "o/r", number: 12 });
  assert.equal(classify("https://gitlab.com/g/sub/proj/-/merge_requests/7/diffs").repo, "g/sub/proj");
  assert.equal(classify("https://codeberg.org/o/r/pulls/4").kind, "gitea-pr");
  assert.equal(classify("https://example.com/design.md").kind, "doc");
  assert.throws(() => classify("not a url"));
  assert.equal(rawUrl("https://github.com/o/r/blob/main/docs/a.md"), "https://raw.githubusercontent.com/o/r/main/docs/a.md");
});

test("htmlText drops scripts and tags", () => {
  const h = htmlText("<html><head><title>T &amp; U</title><script>x()</script></head><body><h1>Hi</h1><p>a&lt;b</p></body></html>");
  assert.equal(h.title, "T & U");
  assert.equal(h.text, "Hi\na<b");
});

const fakeFetch = (pages: Record<string, string>) => (async (url: string) => {
  const body = pages[url];
  return body === undefined ? new Response("no", { status: 404 }) : new Response(body, { headers: { "content-type": url.endsWith(".diff") ? "text/plain" : "text/html" } });
}) as unknown as typeof fetch;

test("GitHub PR via gh; falls back to the public diff without gh", async () => {
  const link = classify("https://github.com/o/r/pull/5");
  const viaGh = await fetchMaterial(link, { gh: async (a) => a[1] === "view" ? JSON.stringify({ title: "Add x", body: "why", author: { login: "bob" }, baseRefName: "main", headRefName: "x", state: "OPEN", files: [1, 2], additions: 3, deletions: 1 }) : "diff --git a b\n" });
  assert.equal(viaGh.title, "Add x");
  assert.match(viaGh.files[0].text, /author: bob[\s\S]*x → main[\s\S]*files: 2 \(\+3 −1\)[\s\S]*why/);
  assert.equal(viaGh.files[1].text, "diff --git a b\n");
  const noGh = await fetchMaterial(link, { gh: async () => { throw new Error("not logged in"); }, fetch: fakeFetch({ "https://github.com/o/r/pull/5.diff": "D", "https://github.com/o/r/pull/5": "<title>Add y</title>" }) });
  assert.equal(noGh.title, "Add y");
  assert.equal(noGh.files[1].text, "D");
  assert.match(noGh.notes[0], /not logged in/);
});

test("doc link: saved as text, brief names the files and the ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lrev-"));
  const brief = await prepareReview(dir, "review: https://example.com/spec what about rollback?", { fetch: fakeFetch({ "https://example.com/spec": "<title>Spec</title><p>Plan</p>" }) });
  assert.ok(brief);
  assert.match(brief!, /^Review this document: Spec/);
  assert.match(brief!, /What I want to know: what about rollback\?/);
  assert.match(brief!, /Do not change any code/);
  const path = /^- (.+doc\.md)$/m.exec(brief!)![1];
  assert.match(await readFile(path, "utf8"), /Plan/);
  assert.equal(await prepareReview(dir, "hello"), null);
  await assert.rejects(prepareReview(dir, "review: https://example.com/gone", { fetch: fakeFetch({}) }), /answered 404/);
});
