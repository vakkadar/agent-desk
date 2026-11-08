import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeName, buildPrompt, checkPaths, saveUpload, servedFile } from "../src/uploads.js";

test("sanitizeName strips paths and odd chars", () => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("C:\\x\\my photo (1).JPG"), "my_photo_1.JPG");
  assert.equal(sanitizeName(".bashrc"), "bashrc");
  assert.equal(sanitizeName("???"), "file");
  assert.equal(sanitizeName(""), "file");
  assert.ok(sanitizeName("a".repeat(200) + ".pdf").length <= 72);
});

test("buildPrompt appends paths", () => {
  assert.equal(buildPrompt("hi", []), "hi");
  assert.equal(buildPrompt("hi", ["/a/b.jpg", "/a/c.pdf"]), "hi\n\nAttached files:\n- /a/b.jpg\n- /a/c.pdf");
});

test("checkPaths and servedFile confine to .desk-uploads", async () => {
  const d = await mkdtemp(join(tmpdir(), "up-"));
  await mkdir(join(d, ".git"));
  const p = await saveUpload(d, "x y.png", Buffer.from("1"));
  assert.deepEqual(checkPaths(d, [p, "/etc/passwd", join(d, ".desk-uploads/../x")]), [p]);
  assert.equal(servedFile(d, "../secret"), null);
  assert.equal(servedFile(d, "2026/a.png")?.type, "image/png");
  await saveUpload(d, "z.png", Buffer.from("2"));
  assert.equal(await readFile(join(d, ".gitignore"), "utf8"), ".desk-uploads/\n");
});
