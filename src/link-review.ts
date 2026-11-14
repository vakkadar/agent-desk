// Review from a link: `review: <url> [what to look at]` in any thread of a local folder.
//   GitHub (and GitHub Enterprise hosts gh is signed in to): `gh pr view` + `gh pr diff`
//   GitLab merge request:  <mr url>.diff  (+ the MR page title)
//   Gitea / Forgejo / Codeberg pull: <pull url>.diff
//   anything else (design doc, issue, gist, blob): the page as text; github blob links read raw
// The material is saved next to the thread's uploads (<folder>/.desk-uploads/<date>/) and the
// agent gets a review brief with the paths. It writes its findings in the reply; nothing is posted
// back to the host and no code is changed.
import { execFile } from "node:child_process";
import { saveUpload } from "./uploads.js";

export type LinkKind = "github-pr" | "gitlab-mr" | "gitea-pr" | "doc";
export interface Link { kind: LinkKind; url: string; host: string; repo?: string; number?: number }
export interface Material { link: Link; title: string; files: { name: string; text: string }[]; notes: string[] }

const MAX_BYTES = 2 << 20;
const MAX_DIFF = 600 << 10;

/** `review: <url> rest` → { url, rest }; null when the message is not a review request. */
export function parseReviewPrefix(text: string): { url: string; rest: string } | null {
  const m = /^\s*review:[ \t]*(\S+)[ \t]*([\s\S]*)$/i.exec(text);
  if (!m || !/^https?:\/\//i.test(m[1])) return null;
  return { url: m[1], rest: m[2].trim() };
}

/** What kind of link this is, from its path shape. Throws on anything not http(s). */
export function classify(raw: string): Link {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`not a link: ${raw.slice(0, 80)}`); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("review: needs an http(s) link");
  u.hash = "";
  const p = u.pathname.replace(/\/+$/, "");
  let m = /^\/(.+?)\/-\/merge_requests\/(\d+)/.exec(p);
  if (m) return { kind: "gitlab-mr", url: `${u.origin}/${m[1]}/-/merge_requests/${m[2]}`, host: u.host, repo: m[1], number: Number(m[2]) };
  m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(p);
  if (m) return { kind: "github-pr", url: `${u.origin}/${m[1]}/pull/${m[2]}`, host: u.host, repo: m[1], number: Number(m[2]) };
  m = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)/.exec(p);
  if (m) return { kind: "gitea-pr", url: `${u.origin}/${m[1]}/pulls/${m[2]}`, host: u.host, repo: m[1], number: Number(m[2]) };
  return { kind: "doc", url: u.toString(), host: u.host };
}

/** github.com/<o>/<r>/blob/<ref>/<path> → raw.githubusercontent.com; other links unchanged. */
export function rawUrl(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}` : url;
}

/** Visible text of an HTML page: scripts, styles and tags dropped, entities for the common few. */
export function htmlText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim();
  const text = html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|pre|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: decode(title), text };
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const cut = (s: string, max: number, what: string, notes: string[]) => {
  if (s.length <= max) return s;
  notes.push(`${what} cut at ${max >> 10} KB of ${Math.round(s.length / 1024)} KB`);
  return s.slice(0, max) + "\n… (cut)\n";
};

async function get(url: string, fetchFn: typeof fetch): Promise<{ type: string; body: string }> {
  const r = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "user-agent": "agent-desk", accept: "text/html,text/plain,text/markdown,*/*" } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}${r.status === 404 || r.status === 401 ? " (private? sign in to the host or paste the diff)" : ""}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { type: r.headers.get("content-type") ?? "", body: buf.subarray(0, MAX_BYTES).toString("utf8") };
}

function gh(args: string[]): Promise<string> {
  return new Promise((res, rej) =>
    execFile("gh", args, { timeout: 30_000, maxBuffer: 8 << 20, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, out, errout) =>
      err ? rej(new Error((errout || err.message).trim().split("\n")[0].slice(0, 200))) : res(out)));
}

export interface Deps { fetch?: typeof fetch; gh?: (args: string[]) => Promise<string> }

/** Fetch what there is to review behind the link. */
export async function fetchMaterial(link: Link, deps: Deps = {}): Promise<Material> {
  const f = deps.fetch ?? fetch, run = deps.gh ?? gh;
  const notes: string[] = [];
  if (link.kind === "github-pr") {
    let meta: any = {};
    let diff = "";
    try {
      meta = JSON.parse(await run(["pr", "view", link.url, "--json", "title,body,author,baseRefName,headRefName,state,files,additions,deletions"]));
      diff = await run(["pr", "diff", link.url]);
    } catch (e: any) {
      // gh missing, or a host gh is not signed in to: the public .diff still works for open repos.
      notes.push(`gh: ${e.message}; used the public diff`);
      diff = (await get(`${link.url}.diff`, f).catch((e2: Error) => { throw new Error(`gh: ${e.message}; public diff: ${e2.message}`); })).body;
      meta = { title: htmlText((await get(link.url, f).catch(() => ({ body: "" }))).body).title };
    }
    const head = [`# ${meta.title ?? `PR #${link.number}`}`, "", `${link.url}`,
      meta.author?.login ? `author: ${meta.author.login}` : "", meta.baseRefName ? `${meta.headRefName} → ${meta.baseRefName}` : "",
      meta.state ? `state: ${String(meta.state).toLowerCase()}` : "",
      Array.isArray(meta.files) ? `files: ${meta.files.length} (+${meta.additions ?? "?"} −${meta.deletions ?? "?"})` : "",
      "", meta.body ?? ""].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
    return { link, title: meta.title ?? `PR #${link.number}`, files: [{ name: "pr.md", text: head }, { name: "pr.diff", text: cut(diff, MAX_DIFF, "diff", notes) }], notes };
  }
  if (link.kind === "gitlab-mr" || link.kind === "gitea-pr") {
    const diff = (await get(`${link.url}.diff`, f)).body;
    const page = htmlText((await get(link.url, f).catch(() => ({ body: "", type: "" }))).body);
    const name = link.kind === "gitlab-mr" ? "MR" : "PR";
    const title = page.title || `${name} !${link.number}`;
    return { link, title, files: [{ name: "pr.md", text: `# ${title}\n\n${link.url}\n\n${cut(page.text, 40 << 10, "page", notes)}` }, { name: "pr.diff", text: cut(diff, MAX_DIFF, "diff", notes) }], notes };
  }
  const src = rawUrl(link.url);
  const r = await get(src, f);
  const isHtml = /html/i.test(r.type) || /^\s*<(!doctype|html)/i.test(r.body);
  const doc = isHtml ? htmlText(r.body) : { title: (/^#\s+(.+)$/m.exec(r.body)?.[1] ?? "").trim(), text: r.body };
  const title = doc.title || new URL(link.url).pathname.split("/").filter(Boolean).pop() || link.host;
  return { link, title, files: [{ name: "doc.md", text: `<!-- ${link.url} -->\n${cut(doc.text, MAX_DIFF, "document", notes)}` }], notes };
}

/** The brief the agent gets, with the saved material's paths. */
export function reviewBrief(m: Material, paths: string[], ask: string): string {
  const pr = m.link.kind !== "doc";
  return [
    `Review ${pr ? "this pull request" : "this document"}: ${m.title}`,
    m.link.url,
    "",
    `Material (read these first):`,
    ...paths.map((p) => `- ${p}`),
    ...(m.notes.length ? ["", `Notes: ${m.notes.join("; ")}`] : []),
    ...(ask ? ["", `What I want to know: ${ask}`] : []),
    "",
    pr
      ? "Read the diff closely; open files in this folder for context when it is the same project. Report, most serious first: bugs and wrong behaviour (with file:line and a concrete failing case), security problems, missing tests, then smaller things. Say what is good too, briefly. End with a verdict: approve, approve with nits, or request changes."
      : "Report, most serious first: what is unclear, wrong or missing, risks and open questions, and what to change. End with a verdict: ready, ready with changes, or not ready.",
    "Do not change any code, do not comment on or approve anything on the host, do not push. Answer here.",
  ].join("\n");
}

/** Fetch, save next to the uploads, and return the prompt text for the turn. */
export async function prepareReview(folder: string, text: string, deps: Deps = {}): Promise<string | null> {
  const p = parseReviewPrefix(text);
  if (!p) return null;
  const link = classify(p.url);
  const m = await fetchMaterial(link, deps);
  const tag = `${(link.repo ?? link.host).replace(/[^\w.-]+/g, "_")}${link.number ? `-${link.number}` : ""}`;
  const paths: string[] = [];
  for (const f of m.files) paths.push(await saveUpload(folder, `review-${tag}-${f.name}`, Buffer.from(f.text)));
  return reviewBrief(m, paths, p.rest);
}
