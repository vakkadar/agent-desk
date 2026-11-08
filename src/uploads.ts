import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir,readFile, appendFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { randomBytes } from "node:crypto";

// Attachments live in <thread folder>/.desk-uploads/<date>/ so Claude can Read them by path.
export const UPLOAD_DIR = ".desk-uploads";
export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_FILES = 5;

/** Safe file name: no path parts, no odd chars, bounded length, extension kept. */
export function sanitizeName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  let s = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "_").replace(/^\.+/, "");
  const ext = extname(s).slice(0, 12);
  s = s.slice(0, s.length - ext.length).slice(0, 60) + ext;
  return s && s !== ext ? s : `file${ext}`;
}

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/plain" };

/** Prompt text with the attached file paths appended for Claude's Read tool. */
export function buildPrompt(text: string, paths: string[]): string {
  if (!paths.length) return text;
  return `${text}\n\nAttached files:\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/** Keep only attachment paths that really sit under <folder>/.desk-uploads. */
export function checkPaths(folder: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const root = resolve(folder, UPLOAD_DIR) + sep;
  return paths.slice(0, MAX_FILES).map(String).filter((p) => resolve(p).startsWith(root));
}

/** Save one upload; returns its absolute path. Adds .desk-uploads/ to .gitignore if the folder is a git repo. */
export async function saveUpload(folder: string, name: string, data: Buffer): Promise<string> {
  const dir = join(folder, UPLOAD_DIR, new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomBytes(3).toString("hex")}-${sanitizeName(name)}`);
  await writeFile(file, data);
  await ignoreUploads(folder).catch(() => {});
  return file;
}

async function ignoreUploads(folder: string) {
  if (!(await stat(join(folder, ".git")).catch(() => null))) return;
  const gi = join(folder, ".gitignore");
  const cur = await readFile(gi, "utf8").catch(() => "");
  if (cur.split("\n").some((l) => l.trim().replace(/^\//, "") === `${UPLOAD_DIR}/`)) return;
  await appendFile(gi, `${cur && !cur.endsWith("\n") ? "\n" : ""}${UPLOAD_DIR}/\n`);
}

/** Absolute file for a served relative path (<date>/<name>), or null if it escapes the uploads dir. */
export function servedFile(folder: string, rel: string): { file: string; type: string } | null {
  const root = resolve(folder, UPLOAD_DIR) + sep;
  const file = resolve(root, rel);
  if (!file.startsWith(root)) return null;
  return { file, type: TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" };
}

export interface UploadHttp {
  /** Role for this request's token (header x-desk-token), same rule as the WebSocket hello. */
  role(req: IncomingMessage, token: string | undefined): string | null;
  sameOrigin(req: IncomingMessage): boolean;
  /** Folder of a source (General: generalDir; project: its location). */
  folder(sourceId: string): string | undefined;
}

/** POST /upload?source=<id> (raw body, x-desk-name) and GET /uploads/<source>/<date>/<file>. Returns true if handled. */
export function handleUploadHttp(req: IncomingMessage, res: ServerResponse, h: UploadHttp): boolean {
  const url = new URL(req.url ?? "/", "http://x");
  const end = (code: number, body?: unknown) => {
    res.writeHead(code, { "content-type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));
  };
  if (req.method === "POST" && url.pathname === "/upload") {
    const token = req.headers["x-desk-token"];
    const folder = h.folder(url.searchParams.get("source") ?? "");
    if (!h.sameOrigin(req) || h.role(req, typeof token === "string" ? token : undefined) !== "action") end(403, { error: "forbidden" });
    else if (!folder) end(404, { error: "no such source" });
    else if (Number(req.headers["content-length"] ?? 0) > MAX_FILE) end(413, { error: "file too large (20 MB max)" });
    else {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > MAX_FILE) { req.destroy(); end(413, { error: "file too large (20 MB max)" }); } else chunks.push(c);
      });
      req.on("end", async () => {
        if (n > MAX_FILE || res.headersSent) return;
        try {
          let name = "file";
          try { name = decodeURIComponent(String(req.headers["x-desk-name"] ?? "")); } catch { /* keep default */ }
          const path = await saveUpload(folder, name, Buffer.concat(chunks));
          end(200, { path, name: path.split(sep).pop() });
        } catch (e: any) {
          end(500, { error: String(e.message ?? e) });
        }
      });
    }
    return true;
  }
  const m = req.method === "GET" && /^\/uploads\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (m) {
    const folder = h.folder(decodeURIComponent(m[1]));
    const f = folder && servedFile(folder, decodeURIComponent(m[2]));
    if (!f) end(404);
    else readFile(f.file).then((b) => res.writeHead(200, { "content-type": f.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" }).end(b), () => end(404));
    return true;
  }
  return false;
}
