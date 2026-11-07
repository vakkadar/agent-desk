// agent-desk server: HTTP (static SPA) + WebSocket (events, prompts).
import { createServer, type IncomingMessage } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { Guard } from "./net/guard.js";
import { CfAccess, viaTunnel } from "./net/cfaccess.js";
import { EventBus } from "./events/bus.js";
import { ThreadStore, slugify, sourceKind, type SourceRec } from "./threads.js";
import { ClaudeAgent } from "./adapters/agent/claude.js";
import { collectHealth, registerBuiltinHealth, registerHealth } from "./health.js";
import { createMux, muxStatus } from "./adapters/mux/index.js";
import { recoverInto } from "./adapters/mux/recover.js";
import type { Mode, Role } from "./types.js";
import { aggregateUsage, readJournal } from "./usage.js";
import { searchEvents } from "./search.js";
import { NotesRecorder, readNotes } from "./notes.js";
import { DeskGit, gitStatus, setDeskGit } from "./git.js";
import { randomUUID } from "node:crypto";
import { Approvals } from "./approvals.js";
import { handleMcp } from "./mcp/permission.js";

const cfg = await loadConfig();
const guard = new Guard(cfg.network);
const cfAccess = cfg.network.cfAccess ? new CfAccess(cfg.network.cfAccess) : null;

/** Admission for HTTP and WS upgrade. Tunnel traffic needs a valid Access JWT; fails closed if Access isn't configured. */
async function admitted(req: IncomingMessage): Promise<boolean> {
  if (viaTunnel(req)) return !!cfAccess && (await cfAccess.verify(req)) !== null;
  return guard.roleFor(req.socket.remoteAddress ?? "") !== null;
}
const bus = new EventBus(join(cfg.dataDir, ".index", "events.jsonl"));
const store = new ThreadStore(cfg.dataDir);
const mux = await createMux(cfg);
const mcpSecret = randomUUID();
const approvals = new Approvals(bus, (t) => (cfg.approvalTimeoutMin[t.split("-")[0] as "ask"] ?? 30) * 60_000);
const agent = new ClaudeAgent({
  spawnFn: mux.spawn,
  permissionMode: process.env.AGENT_DESK_PERMISSION_MODE,
  approvalBase: `http://127.0.0.1:${cfg.port}/mcp/${mcpSecret}`,
});
registerBuiltinHealth(cfg.dataDir);
registerHealth("mux", async () => {
  const s = await muxStatus();
  return { level: s.ok ? "ok" : "warn", detail: s.detail };
});
await bus.init();
await store.load();
await recoverInto(
  mux,
  cfg.dataDir,
  (sid) => {
    for (const rec of store.list())
      for (const th of Object.values(rec.threads)) if (th.session.sessionId === sid) return { sourceId: rec.id, threadId: th.id };
  },
  (w, event) => bus.publish({ ...w, event }),
);

// Notes + desk data repo git (FR-8, FR-19)
const notes = new NotesRecorder(cfg.dataDir, cfg.agent);
const deskGit = new DeskGit(cfg.dataDir, cfg.git);
setDeskGit(deskGit);
registerHealth("git", () => {
  const s = gitStatus();
  const level = !cfg.git.push ? (s.lastCommit ? "ok" : "unknown") : s.lastPushOk === false ? "fail" : s.lastPush ? "ok" : "warn";
  const push = !cfg.git.push ? "push off" : s.lastPush ? `last push ${s.lastPush}${s.lastPushOk ? "" : " (failed)"}` : "never pushed";
  return { level, detail: `last commit ${s.lastCommit ?? "none"} · ${push}${s.pending ? " · commit pending" : ""}` };
});
await deskGit.init().catch((e) => console.error("[git] init failed:", e.message));
notes.onTurnEnd = (r) => deskGit.schedule(`${r.source_id}/${r.thread_id} ${r.outcome?.split(":")[0] ?? "turn"}`);
deskGit.onFlag = (hits, files) => notes.record("note", `secrets redacted (${hits.join(", ")}) in ${files.join(", ")}`, { outcome: "secret-redacted" });
deskGit.onCommit = (hash, msg) => notes.record("commit", `${hash} ${msg}`);
notes.attach(bus);

const webRoot = fileURLToPath(new URL("./web/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const http = createServer(async (req, res) => {
  if (!(await admitted(req))) {
    res.writeHead(403).end();
    return;
  }
  if (!viaTunnel(req) && handleMcp(req, res, mcpSecret, approvals)) return;
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), sources: store.list().length, checks: await collectHealth() }));
    return;
  }
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(webRoot, path === "/" ? "index.html" : path);
  if (!file.startsWith(webRoot)) {
    res.writeHead(400).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found (run `npm run build` for the web UI)");
  }
});

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", async (req, sock, head) => {
  if (!sameOrigin(req) || !(await admitted(req))) {
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => onClient(ws, req));
});

const busy = new Set<string>(); // "source/thread" with a running turn

function onClient(ws: WebSocket, req: IncomingMessage) {
  const ip = req.socket.remoteAddress ?? "";
  let role: Role | null = null;
  let unsub = () => {};
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  // Keepalive: proxies (Cloudflare ~100s) drop idle sockets; also reaps dead mobile links.
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);
  ws.on("close", () => clearInterval(ping));

  ws.on("message", async (raw) => {
    let m: any;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "hello") {
      role = viaTunnel(req) ? guard.tunnelRole(m.token) : guard.roleFor(ip, m.token);
      if (!role) return ws.close(4003, "forbidden");
      send({ type: "welcome", role, keyword: cfg.keyword, sources: store.list() });
      for (const e of bus.since(Number(m.lastSeq) || 0)) send({ type: "event", e });
      unsub();
      unsub = bus.subscribe((e) => send({ type: "event", e }));
      return;
    }
    if (role && (m.type === "usage" || m.type === "search")) {
      await bus.flush();
      const evs = await readJournal(join(cfg.dataDir, ".index", "events.jsonl"));
      if (m.type === "usage") send({ type: "usage", ...aggregateUsage(evs, m.range) });
      else send({ type: "search", q: m.q, hits: searchEvents(evs, String(m.q ?? "")) });
      return;
    }
    if (role !== "action") return send({ type: "error", error: "read-only connection" });
    try {
      await handleAction(m, send);
    } catch (e: any) {
      send({ type: "error", error: String(e?.message ?? e) });
    }
  });
  ws.on("close", () => unsub());
}

async function handleAction(m: any, send: (m: unknown) => void) {
  switch (m.type) {
    case "ls": {
      // Directory autocomplete for the attach form: dirs under the typed prefix.
      const raw = expandHome(String(m.path || "~/"));
      const dir = raw.endsWith("/") ? raw : dirname(raw) + "/";
      const prefix = raw.endsWith("/") ? "" : basename(raw);
      let entries: string[] = [];
      try {
        entries = (await readdir(dir, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && d.name.startsWith(prefix) && (prefix.startsWith(".") || !d.name.startsWith(".")))
          .map((d) => dir + d.name + "/")
          .sort()
          .slice(0, Math.min(Number(m.limit) || 50, 500));
      } catch { /* missing or unreadable dir → no suggestions */ }
      send({ type: "ls", tag: m.tag, path: m.path, dir, entries });
      return;
    }
    case "notes": {
      const date = String(m.date || new Date().toISOString().slice(0, 10));
      send({ type: "notes", date, rows: await readNotes(cfg.dataDir, date) });
      return;
    }
    case "attach": {
      let location = String(m.location).trim();
      if (sourceKind(location) === "local") {
        location = expandHome(location).replace(/\/+$/, "") || "/";
        if (!(await stat(location).catch(() => null))?.isDirectory()) throw new Error(`not a directory: ${location}`);
      }
      const id = slugify(m.name ?? location);
      if (store.get(id)) throw new Error(`source ${id} exists`);
      const cwd = sourceKind(location) === "local" ? location : cfg.dataDir;
      const session = await agent.start({ cwd, name: `${id}-ask` });
      const rec: SourceRec = {
        id, kind: sourceKind(location), location, agent: agent.id,
        threads: { ask: { id: "ask", mode: "ask", session, createdAt: new Date().toISOString() } },
      };
      await store.save(rec);
      send({ type: "sources", sources: store.list() });
      return;
    }
    case "thread": {
      const rec = need(store.get(m.sourceId), "source");
      const mode = m.mode as Exclude<Mode, "ask">;
      if (mode !== "design" && mode !== "code") throw new Error("mode must be design|code");
      const id = store.nextThreadId(rec, mode);
      const session = await agent.fork(rec.threads.ask.session);
      rec.threads[id] = { id, mode, session, createdAt: new Date().toISOString() };
      await store.save(rec);
      send({ type: "sources", sources: store.list() });
      return;
    }
    case "prompt": {
      const rec = need(store.get(m.sourceId), "source");
      const th = need(rec.threads[m.threadId], "thread");
      const key = `${rec.id}/${th.id}`;
      if (busy.has(key)) throw new Error("thread busy");
      busy.add(key);
      const text = `${cfg.keyword}[${th.id}]: ${m.text}`; // FR-12
      bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "prompt", text } });
      try {
        for await (const ev of agent.send(th.session, text, { sourceId: rec.id, threadId: th.id })) {
          bus.publish({ sourceId: rec.id, threadId: th.id, event: ev });
        }
      } finally {
        busy.delete(key);
        await store.save(rec); // persists session id assigned on fork
      }
      return;
    }
    case "approve": {
      // Role gate: handleAction is only reachable for action-role connections.
      if (!approvals.resolve(String(m.id), m.allow === true, "browser")) throw new Error("approval already resolved or unknown");
      return;
    }
    default:
      throw new Error(`unknown message ${m.type}`);
  }
}

function expandHome(p: string): string {
  return p === "~" ? homedir() + "/" : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`no such ${what}`);
  return v;
}

for (const host of cfg.network.bind) {
  // One listener per bind address; http.Server can listen once, so clone per extra host.
  const srv = host === cfg.network.bind[0] ? http : createServer(http.listeners("request")[0] as any);
  if (srv !== http) srv.on("upgrade", (...a) => http.emit("upgrade", ...a));
  srv.listen(cfg.port, host, () => console.log(`agent-desk listening on http://${host}:${cfg.port}`));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await bus.flush();
    await notes.flush();
    await deskGit.commitNow();
    process.exit(0);
  });
}
