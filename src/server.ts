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
import { onPtyClient, listSessions } from "./pty.js";
import { DeskGit, gitStatus, setDeskGit } from "./git.js";
import { randomUUID } from "node:crypto";
import { Approvals } from "./approvals.js";
import { Push } from "./push.js";
import { handleMcp } from "./mcp/permission.js";
import { isSessionId, listSessions as listClaudeSessions } from "./claude-sessions.js";
import { parseExisting, GENERAL_ID, ensureGeneral, ensureGeneralHerdr, routeGeneral } from "./general.js";
import { contextUsed } from "./context.js";
import { LiveFollower } from "./live-follow.js";
import { HerdrSessions, acceptTrust, runningSessions, startSession, stopSession, trustPending } from "./herdr-sessions.js";
import { LiveClaude, listPanes, pickLive, type LivePane } from "./live.js";
import { summarize } from "./notes.js";
import { handleUploadHttp, checkPaths, buildPrompt } from "./uploads.js";
import { Scheduler, scheduleTitle } from "./schedule.js";

const cfg = await loadConfig();
const guard = new Guard(cfg.network);
const cfAccess = cfg.network.cfAccess ? new CfAccess(cfg.network.cfAccess) : null;

// Tunnel requests whose Access login is one of the owners (full access without the desk token).
const ownerReqs = new WeakSet<IncomingMessage>();

/** Admission for HTTP and WS upgrade. Tunnel traffic needs a valid Access JWT; fails closed if Access isn't configured. */
async function admitted(req: IncomingMessage): Promise<boolean> {
  if (viaTunnel(req)) {
    if (!cfAccess) return false;
    const who = await cfAccess.verify(req);
    if (cfAccess.isOwner(who)) ownerReqs.add(req);
    return who !== null;
  }
  return guard.roleFor(req.socket.remoteAddress ?? "") !== null;
}

/** Role for a request (after admitted()). Over the tunnel: owners get action, others need the token. */
function roleOf(req: IncomingMessage, token?: string) {
  if (viaTunnel(req)) return ownerReqs.has(req) ? "action" : guard.tunnelRole(token);
  return guard.roleFor(req.socket.remoteAddress ?? "", token);
}
const bus = new EventBus(join(cfg.dataDir, ".index", "events.jsonl"));
const store = new ThreadStore(cfg.dataDir);
const mux = await createMux(cfg);
const hsessions = new HerdrSessions(cfg.dataDir);
// Your live_sessions plus every named session opened from the desk.
const liveClaude = new LiveClaude(() => [...cfg.liveSessions, ...hsessions.openNames()]);
// Persistent sessions come back with the desk (reboot, restart), resuming Claude's last conversation.
void (async () => {
  const up = await runningSessions();
  for (const s of hsessions.toRestore().filter((x) => !up.has(x.name)))
    await startSession(s, { resume: true }).then(() => console.log(`[sessions] restored ${s.name}`), (e) => console.error(`[sessions] restore ${s.name} failed: ${e.message}`));
})();
const mcpSecret = randomUUID();
// Claude gives up on an MCP tool call after ~60s by default, and the browser approval is
// one: let it wait as long as the desk does.
process.env.MCP_TOOL_TIMEOUT ??= String((Math.max(...Object.values(cfg.approvalTimeoutMin)) + 1) * 60_000);
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
const push = new Push(cfg.dataDir);
await push.init();
push.attach(bus);
await store.load();
await ensureGeneral(store, agent, cfg.generalDir);
if (mux.herdr) {
  // Keep an interactive Claude open in the General herdr session; restart it if it exits.
  const keepGeneral = () => ensureGeneralHerdr(cfg.dataDir, cfg.generalDir).catch((e) => console.warn("[general] herdr session:", e.message));
  keepGeneral();
  setInterval(keepGeneral, 5 * 60_000).unref();
}
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
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const http = createServer(async (req, res) => {
  if (!(await admitted(req))) {
    res.writeHead(403).end();
    return;
  }
  if (!viaTunnel(req) && handleMcp(req, res, mcpSecret, approvals)) return;
  if (handleUploadHttp(req, res, {
    role: (r, token) => roleOf(r, token),
    sameOrigin,
    folder: (id) => store.get(id)?.location,
  })) return;
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), sources: store.list().length, checks: await collectHealth() }));
    return;
  }
  if (req.url === "/pty/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(await listSessions()));
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
const ptyWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
http.on("upgrade", async (req, sock, head) => {
  if (!sameOrigin(req) || !(await admitted(req))) {
    sock.destroy();
    return;
  }
  if ((req.url ?? "").split("?")[0] === "/pty") {
    ptyWss.handleUpgrade(req, sock, head, (ws) =>
      onPtyClient(ws, req, { resolveRole: (token) => roleOf(req, token) }));
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => onClient(ws, req));
});

const busy = new Map<string, AbortController>(); // "source/thread" with a running turn
const helloed = new Set<(m: unknown) => void>(); // senders of clients past "hello"
// Show what happens in the user's Claude windows even when typed in the terminal (only while a browser is open).
new LiveFollower(
    liveClaude,
    () => store.list().filter((r) => r.id !== GENERAL_ID && r.kind !== "url"),
    (sourceId, event) => bus.publish({ sourceId, threadId: "ask", event }),
    (id) => helloed.size > 0 && !busy.has(`${id}/ask`),
  ).start();
const broadcastSources = () => { for (const s of helloed) s({ type: "sources", sources: store.list() }); };
const broadcastHSessions = async () => {
  const rows = hsessions.rows4web(await runningSessions());
  for (const s of helloed) s({ type: "hsessions", rows });
};

/** New source for a folder (or URL), with its base Ask thread. */
async function newSource(location: string, name?: string): Promise<SourceRec> {
  const id = slugify(name ?? location);
  if (store.get(id)) throw new Error(`source ${id} exists`);
  const cwd = sourceKind(location) === "local" ? location : cfg.dataDir;
  const session = await agent.start({ cwd, name: `${id}-ask` });
  const rec: SourceRec = {
    id, kind: sourceKind(location), location, agent: agent.id,
    threads: { ask: { id: "ask", mode: "ask", session, createdAt: new Date().toISOString() } },
  };
  await store.save(rec);
  return rec;
}

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
      role = roleOf(req, m.token);
      if (!role) return ws.close(4003, "forbidden");
      send({ type: "welcome", role, keyword: cfg.keyword, hubUrl: cfg.hubUrl, sources: store.list() });
      for (const e of bus.since(Number(m.lastSeq) || 0)) send({ type: "event", e });
      unsub();
      unsub = bus.subscribe((e) => send({ type: "event", e }));
      helloed.add(send);
      return;
    }
    if (role && m.type === "schedules") return send({ type: "schedules", rows: scheduler.rows() });
    if (role && m.type === "hsessions") return send({ type: "hsessions", rows: hsessions.rows4web(await runningSessions()) });
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
  ws.on("close", () => { unsub(); helloed.delete(send); });
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
    case "note": {
      // Hand-written note (turns are recorded automatically).
      const text = String(m.text ?? "").trim().slice(0, 4000);
      if (!text) throw new Error("empty note");
      notes.record("note", text, m.sourceId ? { source_id: String(m.sourceId) } : {});
      await notes.flush();
      const date = new Date().toISOString().slice(0, 10);
      await notes.renderMarkdown(date);
      send({ type: "notes", date, rows: await readNotes(cfg.dataDir, date) });
      return;
    }
    case "attach": {
      let location = String(m.location).trim();
      if (sourceKind(location) === "local") {
        location = expandHome(location).replace(/\/+$/, "") || "/";
        if (!(await stat(location).catch(() => null))?.isDirectory()) throw new Error(`not a directory: ${location}`);
      }
      await newSource(location, m.name);
      broadcastSources();
      return;
    }
    case "hsession_open": {
      // Named herdr session: check PIN, start it (and Claude) if needed, bind a source to it.
      const name = String(m.name);
      hsessions.verify(name, m.pin);
      const s = hsessions.get(name)!;
      if (!(await stat(s.dir).catch(() => null))?.isDirectory()) throw new Error(`folder missing: ${s.dir}`);
      await startSession(s, { resume: true });
      let rec = store.list().find((r) => r.herdrSession === name);
      if (!rec) {
        const same = store.list().find((r) => r.kind === "local" && r.location === s.dir && !r.builtin && !r.herdrSession);
        rec = same ?? (await newSource(s.dir, store.get(slugify(name)) ? `${name}-session` : name));
        rec.herdrSession = name;
        await store.save(rec);
      }
      hsessions.setState(name, "open");
      broadcastSources();
      void broadcastHSessions();
      send({ type: "focus", sourceId: rec.id, threadId: "ask" });
      if (await trustPending(name)) send({ type: "hsession_trust", name, dir: s.dir });
      return;
    }
    case "hsession_trust": {
      // The user tapped "Trust folder": answer Claude's first-run question in that window.
      const name = String(m.name);
      hsessions.verify(name, m.pin);
      await acceptTrust(name);
      void broadcastHSessions();
      return;
    }
    case "hsession_persist": {
      const name = String(m.name);
      hsessions.verify(name, m.pin);
      hsessions.setPersistent(name, m.on === true);
      void broadcastHSessions();
      return;
    }
    case "hsession_close": {
      const name = String(m.name);
      hsessions.verify(name, m.pin);
      await stopSession(name);
      hsessions.setState(name, "closed");
      void broadcastHSessions();
      return;
    }
    case "sessions": {
      // Past Claude sessions for a local source (resume picker).
      const rec = need(store.get(m.sourceId), "source");
      const sessions = rec.kind === "local" ? await listClaudeSessions(rec.location) : [];
      send({ type: "sessions", sourceId: rec.id, sessions });
      return;
    }
    case "thread": {
      const rec = need(store.get(m.sourceId), "source");
      const mode = m.mode as Exclude<Mode, "ask">;
      if (mode !== "design" && mode !== "code") throw new Error("mode must be design|code");
      const id = store.nextThreadId(rec, mode);
      let session;
      if (m.resume !== undefined) {
        // Continue (or fork, if still open elsewhere) an existing Claude session from this dir.
        if (!isSessionId(m.resume) || rec.kind !== "local") throw new Error("bad session");
        const known = (await listClaudeSessions(rec.location, { limit: 1000 })).find((s) => s.id === m.resume);
        if (!known) throw new Error("no such session in this folder");
        const base = { agent: agent.id, sessionId: m.resume, cwd: rec.location, started: true };
        session = m.fork ? await agent.fork(base) : await agent.resume(base);
      } else session = await agent.fork(rec.threads.ask.session);
      rec.threads[id] = { id, mode, session, createdAt: new Date().toISOString() };
      await store.save(rec);
      send({ type: "sources", sources: store.list() });
      return;
    }
    case "prompt":
      await runPrompt(m, send);
      return;
    case "schedule_run":
      if (!scheduler.runNow(String(m.name))) throw new Error(`schedule ${m.name} is still running`);
      send({ type: "schedules", rows: scheduler.rows() });
      return;
    case "close": {
      // Close (fold away) or reopen a thread. Nothing is deleted; the transcript stays.
      const rec = need(store.get(m.sourceId), "source");
      const th = need(rec.threads[m.threadId], "thread");
      if (th.id === "ask") throw new Error("the main Ask thread can't be closed");
      if (m.closed === false) delete th.closed;
      else th.closed = new Date().toISOString();
      await store.save(rec);
      broadcastSources();
      return;
    }
    case "hub_answer": {
      // The browser's reply from the hub for a turn hubTurn is waiting on.
      const done = hubWait.get(`${m.sourceId}/${m.threadId}`);
      if (!done) throw new Error("no hub turn waiting in that thread");
      done({ text: m.text == null ? undefined : String(m.text), error: m.error == null ? undefined : String(m.error), model: m.model == null ? undefined : String(m.model) });
      return;
    }
    case "cancel": {
      // Stop a running turn: kill the agent process, deny its open approvals.
      const ac = busy.get(`${m.sourceId}/${m.threadId}`);
      if (!ac) throw new Error("nothing running in that thread");
      ac.abort();
      approvals.denyThread(String(m.sourceId), String(m.threadId), "cancelled");
      return;
    }
    case "approve": {
      // Role gate: handleAction is only reachable for action-role connections.
      if (!approvals.resolve(String(m.id), m.allow === true, "browser")) throw new Error("approval already resolved or unknown");
      return;
    }
    case "push_key":
      send({ type: "push_key", key: push.publicKey });
      return;
    case "push_subscribe":
      await push.subscribe(m.sub);
      return;
    case "push_unsubscribe":
      await push.unsubscribe(String(m.endpoint));
      return;
    case "live_answer": {
      // Answer the permission prompt of a live Claude window; LiveClaude re-checks the window first.
      const rec = need(store.get(m.sourceId), "source");
      const opt = await liveClaude.answer(String(m.id), String(m.key));
      bus.publish({ sourceId: rec.id, threadId: String(m.threadId), event: { kind: "approval_result", id: String(m.id), decision: opt.allow ? "allow" : "deny", by: "browser" } });
      return;
    }
    default:
      throw new Error(`unknown message ${m.type}`);
  }
}

/**
 * One prompt turn, shared by the browser "prompt" action and scheduled runs.
 * opts.title: name for a new General question. opts.noLive: use the desk's own session, never the live herdr window.
 */
async function runPrompt(m: any, send: (m: unknown) => void, opts: { title?: string; noLive?: boolean } = {}) {
  const rec = need(store.get(m.sourceId), "source");
  let th;
  const picked = rec.id === GENERAL_ID && m.threadId !== "ask" ? rec.threads[m.threadId] : undefined;
  if (picked && !parseExisting(String(m.text ?? ""))) {
    th = picked; // General question picked in the list: continue it, no prefix needed
  } else if (rec.id === GENERAL_ID) {
    // General: new session per prompt unless "c: <match>" on the first line.
    const r = await routeGeneral(rec, agent, String(m.text ?? ""), (t) => opts.title ?? summarize(t, 80));
    th = r.thread;
    m.text = r.text;
    if (r.created) {
      await store.save(rec);
      broadcastSources();
    }
    send({ type: "focus", sourceId: rec.id, threadId: th.id });
  } else th = need(rec.threads[m.threadId], "thread");
  if (th.closed) { // writing to a closed thread reopens it
    delete th.closed;
    await store.save(rec);
    broadcastSources();
  }
  // Project Ask: go into the Claude window already open in that folder (one conversation
  // per folder). "new:" skips it; "c: w3" picks a window when several are open.
  let live: LivePane | undefined;
  const bound = rec.herdrSession ? hsessions.get(rec.herdrSession) : undefined;
  if (rec.herdrSession && !opts.noLive) {
    // A named session's source: PIN on every browser prompt, and only while the session is open.
    // (Scheduled runs use the desk's own session and skip this.)
    if (!bound) throw new Error(`session ${rec.herdrSession} is no longer registered`);
    hsessions.verify(bound.name, m.pin);
    if (bound.state !== "open") throw new Error(`session ${bound.name} is ${bound.state}; open it from Sessions (⋯ menu)`);
  }
  if (m.hub) return hubTurn(rec, th, m, send);
  if (rec.id !== GENERAL_ID && th.id === "ask" && !opts.noLive && (cfg.liveSessions.length || bound)) {
    const raw = String(m.text ?? "");
    const nw = /^\s*new:[ \t]*/i.exec(raw);
    if (nw) m.text = raw.slice(nw[0].length).trim();
    else {
      const ex = parseExisting(raw);
      const panes = await liveClaude.find(rec.location, bound ? [bound.name] : undefined);
      const pick = pickLive(panes, ex?.query);
      if (ex) {
        if (pick.kind === "none") throw new Error(`no open Claude window in ${rec.location} matches "${ex.query}"${panes.length ? `. Open:\n${listPanes(panes)}` : ""}`);
        if (!ex.rest) throw new Error("c: add your message after the window id (c: w3 your message)");
        m.text = ex.rest;
      }
      if (pick.kind === "many") throw new Error(`${pick.panes.length} Claude windows are open in ${rec.location}. Pick one:\n${listPanes(pick.panes)}\nor new: <message> for a separate session`);
      if (pick.kind === "one") {
        if (pick.pane.status === "working" || pick.pane.status === "blocked")
          throw new Error(`Claude window ${pick.pane.paneId} is busy (${pick.pane.status}). Wait for it, or new: <message> for a separate session`);
        live = pick.pane;
      }
    }
    if (!String(m.text ?? "").trim()) throw new Error("empty message");
  }
  const key = `${rec.id}/${th.id}`;
  if (busy.has(key)) throw new Error("thread busy");
  const ac = new AbortController();
  busy.set(key, ac);
  // FR-12 tag, except Claude commands like /compact, which must arrive as typed.
  const body = buildPrompt(String(m.text), checkPaths(rec.location, m.attachments));
  const text = body.trimStart().startsWith("/") ? body.trim() : `${cfg.keyword}[${th.id}]: ${body}`;
  bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "prompt", text } });
  try {
    const turn = live
      ? liveClaude.send(live, text, ac.signal)
      : agent.send(th.session, text, { sourceId: rec.id, threadId: th.id, signal: ac.signal, permissionMode: cfg.permissionMode[rec.id] ?? cfg.permissionMode[th.mode] });
    if (live) bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "text", text: `_→ your Claude window ${live.paneId} (${live.title || live.sessionId?.slice(0, 8)})_\n\n` } });
    for await (const ev of turn) {
      bus.publish({ sourceId: rec.id, threadId: th.id, event: ev });
    }
    const sid = live?.sessionId ?? th.session.sessionId;
    const used = sid ? await contextUsed(live?.cwd ?? th.session.cwd, sid).catch(() => undefined) : undefined;
    if (used) bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "context", used, limit: cfg.contextLimit } });
  } finally {
    busy.delete(key);
    await store.save(rec); // persists session id assigned on fork
  }
}

// Ask run on the hub. The browser holds the hub sign-in, so it makes the call; the desk
// records the turn in the thread (prompt, answer, done) like any other, and holds the
// thread busy until the browser reports back (hub_answer) or the wait runs out.
const HUB_WAIT_MS = 330_000; // hub's own runtime budget is 300 s
type HubReply = { text?: string; error?: string; model?: string };
const hubWait = new Map<string, (r: HubReply) => void>();

async function hubTurn(rec: SourceRec, th: { id: string }, m: any, send: (m: unknown) => void) {
  if (!cfg.hubUrl) throw new Error("no hub configured ([hub] url in desk.toml)");
  const text = String(m.text ?? "").trim();
  if (!text) throw new Error("empty message");
  const agentId = String(m.hub.agent || "expert").slice(0, 60);
  const model = String(m.hub.model || "").slice(0, 120);
  const key = `${rec.id}/${th.id}`;
  if (busy.has(key)) throw new Error("thread busy");
  const ac = new AbortController();
  busy.set(key, ac);
  bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "prompt", text: `hub:${agentId}${model ? ` ${model}` : ""}[${th.id}]: ${text}` } });
  try {
    const r = await new Promise<HubReply>((res) => {
      hubWait.set(key, res);
      ac.signal.addEventListener("abort", () => res({ error: "cancelled" }));
      setTimeout(() => res({ error: "the hub did not answer in time" }), HUB_WAIT_MS);
      send({ type: "hub_go", sourceId: rec.id, threadId: th.id, text, agent: agentId, model });
    });
    if (r.text) bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "text", text: r.model ? `${r.text}\n\n_— hub · ${agentId} · ${r.model}_` : r.text } });
    const outcome = r.error === "cancelled" ? "cancelled" : r.error ? "error" : "ok";
    bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "done", outcome, ...(r.error && outcome === "error" ? { error: `hub: ${r.error}` } : {}) } });
  } finally {
    hubWait.delete(key);
    busy.delete(key);
    await store.save(rec);
  }
}

function expandHome(p: string): string {
  return p === "~" ? homedir() + "/" : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`no such ${what}`);
  return v;
}

// Scheduled prompts: same path as a browser prompt, but on the desk's own session.
const scheduler = new Scheduler(cfg.schedules, join(cfg.dataDir, ".index", "schedule-state.json"), (sch) =>
  runPrompt({ sourceId: sch.source, threadId: "ask", text: sch.prompt }, () => {}, { title: scheduleTitle(sch), noLive: true }));
await scheduler.start();

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
