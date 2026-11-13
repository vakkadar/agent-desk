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
import { featuresOf, needFeature, profileFor, type Feature } from "./profiles.js";
import { BROWSER_KINDS, openaiAsk, openaiModels, publicTarget, type AskTarget } from "./ask-targets.js";
import { promptTag, signature, targetHistory } from "./ask-history.js";
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
import { Pairs } from "./pair.js";
import { desk2Action } from "./desk2-api.js";
import { MergeQueue } from "./merge-queue.js";
import { readReview } from "./review.js";
import { mailText } from "./links.js";
import { ensureWorktree, isGitRepo, snapshot, type Worktree } from "./worktree.js";
import { DESK_DEV_ID, DESK_REPO, commitTurn, insideRepo, isSelfSource } from "./self-dev.js";

const cfg = await loadConfig();
const guard = new Guard(cfg.network);
const cfAccess = cfg.network.cfAccess ? new CfAccess(cfg.network.cfAccess) : null;

// Verified Access identity of each tunnel request (email, or "service-token").
const identities = new WeakMap<IncomingMessage, string>();

/** Admission for HTTP and WS upgrade. Tunnel traffic needs a valid Access JWT; fails closed if Access isn't configured. */
async function admitted(req: IncomingMessage): Promise<boolean> {
  if (viaTunnel(req)) {
    if (!cfAccess) return false;
    const who = await cfAccess.verify(req);
    if (who !== null) identities.set(req, who);
    return who !== null;
  }
  return guard.roleFor(req.socket.remoteAddress ?? "") !== null;
}

/** Role for a request (after admitted()). Over the tunnel: owners get action, others need the token. */
function roleOf(req: IncomingMessage, token?: string) {
  if (viaTunnel(req)) return cfAccess?.isOwner(identities.get(req) ?? null) ? "action" : guard.tunnelRole(token);
  return guard.roleFor(req.socket.remoteAddress ?? "", token);
}

/** A guest: came over the tunnel with an Access login that is not an owner. */
function isGuest(req: IncomingMessage): boolean {
  return viaTunnel(req) && !cfAccess?.isOwner(identities.get(req) ?? null);
}

/** Profile for a request: its Access email's own, else guest_profile for a guest, else the desk default. */
function profileOf(req: IncomingMessage) {
  return profileFor(cfg.profiles, identities.get(req), isGuest(req));
}
function featuresFor(req: IncomingMessage): Set<Feature> {
  return featuresOf(profileOf(req));
}

/** The desk's own code (any source inside its repo) is for the admin profile only. */
const seesSelf = (features: Set<Feature>) => features.has("self");
const sourcesFor = (features: Set<Feature>) => store.list().filter((r) => seesSelf(features) || !isSelfSource(r));
const eventFor = (features: Set<Feature>, sourceId: string) => seesSelf(features) || !isSelfSource(store.get(sourceId));
const hsessionsFor = <T extends { name: string; dir: string }>(features: Set<Feature>, rows: T[]) =>
  seesSelf(features) ? rows : rows.filter((r) => r.name !== cfg.selfDevSession && !insideRepo(r.dir));
const selfSession = (name: string) => name === cfg.selfDevSession || insideRepo(hsessions.get(name)?.dir ?? "/nonexistent-dir");

/** guest_ask: a read-only connection may ask a browser-side target (the call runs on the
 *  guest's own sign-in there) as a new or picked General question. Nothing else. */
function guestAskOk(m: any): boolean {
  if (!cfg.profiles.guestAsk) return false;
  if (m.type === "target_answer") return true;
  if (m.type !== "prompt" || m.sourceId !== GENERAL_ID || m.hub) return false;
  const t = cfg.askTargets.find((x) => x.id === m.target?.id);
  const text = String(m.text ?? "");
  return !!t && BROWSER_KINDS.includes(t.kind) && !text.trimStart().startsWith("/") && !parseExisting(text);
}
const bus = new EventBus(join(cfg.dataDir, ".index", "events.jsonl"));
const store = new ThreadStore(cfg.dataDir);
const mux = await createMux(cfg);
const hsessions = new HerdrSessions(cfg.dataDir);
const pairs = new Pairs(cfg.dataDir);
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
if (cfg.selfDev && !store.get(DESK_DEV_ID)) {
  // Desk dev: the desk's own repo as a source (admin profile only).
  const session = await agent.start({ cwd: DESK_REPO, name: `${DESK_DEV_ID}-ask` });
  await store.save({ id: DESK_DEV_ID, kind: "local", location: DESK_REPO, agent: agent.id, builtin: true,
    threads: { ask: { id: "ask", mode: "ask", session, createdAt: new Date().toISOString() } } });
}
// The desk's own code: every tool use asks for approval unless desk.toml says otherwise.
cfg.permissionMode[DESK_DEV_ID] ??= "default";
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
    folder: (id, req) => {
      const rec = store.get(id);
      return isSelfSource(rec) && !seesSelf(featuresFor(req)) ? undefined : rec?.location;
    },
  })) return;
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), sources: store.list().length, checks: await collectHealth() }));
    return;
  }
  if (req.url === "/pty/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    const f = featuresFor(req);
    res.end(JSON.stringify((await listSessions()).filter((n) => seesSelf(f) || !selfSession(n))));
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
      onPtyClient(ws, req, {
        resolveRole: (token) => {
          const f = featuresFor(req);
          const name = new URL(req.url ?? "", "http://x").searchParams.get("session") ?? "";
          return f.has("terminal") && (seesSelf(f) || !selfSession(name)) ? roleOf(req, token) : null;
        },
      }));
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => onClient(ws, req));
});

const busy = new Map<string, AbortController>(); // "source/thread" with a running turn
const helloed = new Map<(m: unknown) => void, Set<Feature>>(); // senders of clients past "hello", with their features
// Show what happens in the user's Claude windows even when typed in the terminal (only while a browser is open).
new LiveFollower(
    liveClaude,
    () => store.list().filter((r) => r.id !== GENERAL_ID && r.kind !== "url"),
    (sourceId, event) => bus.publish({ sourceId, threadId: "ask", event }),
    (id) => helloed.size > 0 && !busy.has(`${id}/ask`),
  ).start();
const mergeQueue = new MergeQueue(cfg.dataDir, {
  review: async (it) => { const rec = store.get(it.sourceId); return readReview(rec?.location ?? it.repo, it.threadId, it.worktree); },
  onChange: (items) => { for (const [s, f] of helloed) if (f.has("code")) s({ type: "merge_queue", items: items.filter((i) => seesSelf(f) || !isSelfSource(store.get(i.sourceId))) }); },
});
const broadcastSources = () => { for (const [s, f] of helloed) s({ type: "sources", sources: sourcesFor(f) }); };
const broadcastHSessions = async () => {
  const rows = hsessions.rows4web(await runningSessions());
  for (const [s, f] of helloed) s({ type: "hsessions", rows: hsessionsFor(f, rows) });
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
  let features = new Set<Feature>();
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
      const profile = profileOf(req);
      features = featuresOf(profile);
      send({ type: "welcome", role, keyword: cfg.keyword, profile, features: [...features], guestAsk: cfg.profiles.guestAsk, targets: cfg.askTargets.map(publicTarget), sources: sourcesFor(features) });
      const f = features;
      for (const e of bus.since(Number(m.lastSeq) || 0)) if (eventFor(f, e.sourceId)) send({ type: "event", e });
      unsub();
      unsub = bus.subscribe((e) => eventFor(f, e.sourceId) && send({ type: "event", e }));
      helloed.set(send, f);
      return;
    }
    if (role && m.type === "schedules") return send({ type: "schedules", rows: scheduler.rows() });
    if (role && m.type === "hsessions") return send({ type: "hsessions", rows: hsessionsFor(features, hsessions.rows4web(await runningSessions())) });
    if (role && (m.type === "usage" || m.type === "search")) {
      await bus.flush();
      const evs = await readJournal(join(cfg.dataDir, ".index", "events.jsonl"));
      if (m.type === "usage") send({ type: "usage", ...aggregateUsage(evs.filter((e) => eventFor(features, e.sourceId)), m.range) });
      else send({ type: "search", q: m.q, hits: searchEvents(evs.filter((e) => eventFor(features, e.sourceId)), String(m.q ?? "")) });
      return;
    }
    if (role !== "action" && !guestAskOk(m)) return send({ type: "error", error: "read-only connection" });
    if (role !== "action") m.attachments = [];
    try {
      await handleAction(m, send, features);
    } catch (e: any) {
      send({ type: "error", error: String(e?.message ?? e) });
    }
  });
  ws.on("close", () => { unsub(); helloed.delete(send); });
}

async function handleAction(m: any, send: (m: unknown) => void, features: Set<Feature>) {
  if (String(m.type).startsWith("hsession_")) needFeature(features, "sessions");
  if (m.sourceId != null && isSelfSource(store.get(String(m.sourceId)))) needFeature(features, "self");
  if (m.type === "attach" && sourceKind(String(m.location ?? "")) === "local" && insideRepo(expandHome(String(m.location).trim()))) needFeature(features, "self");
  if (String(m.type).startsWith("hsession_") && m.name != null && selfSession(String(m.name))) needFeature(features, "self");
  if (m.type === "thread") needFeature(features, m.mode === "code" ? "code" : "design");
  if (m.type === "mail" || m.type === "links") needFeature(features, "design");
  if (/^(pair|merge)_|^files$|^file_diff$|^review$/.test(String(m.type))) needFeature(features, "code");
  if (await desk2Action(m, { store, pairs, send, mergeQueue, seesSelf: seesSelf(features), events: async () => { await bus.flush(); return readJournal(join(cfg.dataDir, ".index", "events.jsonl")); } })) return;
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
      let session, wt: Worktree | undefined;
      if (m.resume !== undefined) {
        // Continue (or fork, if still open elsewhere) an existing Claude session from this dir.
        if (!isSessionId(m.resume) || rec.kind !== "local") throw new Error("bad session");
        const known = (await listClaudeSessions(rec.location, { limit: 1000 })).find((s) => s.id === m.resume);
        if (!known) throw new Error("no such session in this folder");
        const base = { agent: agent.id, sessionId: m.resume, cwd: rec.location, started: true };
        session = m.fork ? await agent.fork(base) : await agent.resume(base);
      } else if (mode === "code" && rec.kind === "local" && m.worktree !== false && (await isGitRepo(rec.location))) {
        // Own git worktree on its own branch: parallel threads never collide in one checkout.
        wt = await ensureWorktree(rec.location, id);
        session = await agent.start({ cwd: wt.worktree, name: `${rec.id}-${id}` });
      } else session = await agent.fork(rec.threads.ask.session);
      rec.threads[id] = { id, mode, session, createdAt: new Date().toISOString(), ...(wt ?? {}) };
      if (m.from && rec.threads[String(m.from)]) rec.threads[id].from = String(m.from);
      await store.save(rec);
      send({ type: "sources", sources: sourcesFor(features) });
      return;
    }
    case "prompt": {
      // Snapshot a worktree thread before the turn: the "since my last message" diff base.
      const th = store.get(String(m.sourceId))?.threads[String(m.threadId)];
      if (th?.worktree) { th.lastSnap = await snapshot(th.worktree).catch(() => th.lastSnap); await store.save(store.get(String(m.sourceId))!); }
      await runPrompt(m, send);
      return;
    }
    case "mail": {
      // Mailbox: one thread tells another something; it arrives as a turn for that thread's builder.
      const rec = need(store.get(m.sourceId), "source");
      const from = need(rec.threads[String(m.from)], "thread").id;
      const to = need(rec.threads[String(m.to)], "thread").id;
      if (from === to) throw new Error("mail needs two different threads");
      await runPrompt({ sourceId: rec.id, threadId: to, text: mailText(from, String(m.text ?? "").slice(0, 20_000)) }, send);
      return;
    }
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
    case "target_answer":
    case "hub_answer": {
      // The page's reply for a browser-side target turn that targetTurn is waiting on.
      const w = targetWait.get(`${m.sourceId}/${m.threadId}`);
      // Only the page that was asked may answer (a guest can't answer someone else's turn).
      if (!w || w.send !== send) throw new Error("no ask-target turn waiting in that thread");
      w.done({ text: m.text == null ? undefined : String(m.text), error: m.error == null ? undefined : String(m.error), model: m.model == null ? undefined : String(m.model) });
      return;
    }
    case "target_models": {
      // Models for a server-side target (the page lists browser ones itself).
      const t = need(cfg.askTargets.find((x) => x.id === m.target && x.kind === "openai"), "ask target");
      send({ type: "target_models", target: t.id, models: await openaiModels(t), default: t.defaultModel ?? "" });
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
  if ((m.target && m.target.id !== "local") || m.hub) return targetTurn(rec, th, m, send);
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
    if (isSelfSource(rec)) {
      // The desk's own code: commit what the turn changed (push stays manual).
      const said = (t: string) => bus.publish({ sourceId: rec.id, threadId: th.id, event: { kind: "text", text: `\n\n_${t}_` } });
      await commitTurn(rec.location, text, th.id)
        .then((h) => h && said(`committed ${h} in ${rec.location} (not pushed)`))
        .catch((e) => said(`commit failed: ${e.message}`));
    }
    busy.delete(key);
    await store.save(rec); // persists session id assigned on fork
  }
}

// Ask on another target ([[ask_target]]). The turn is logged in the thread like any other
// (tagged prompt, answer, done), so it shows in history and notes.
// - browser kinds: the page holds the sign-in, so it makes the call: the desk sends
//   target_go and keeps the thread busy until target_answer comes back or the wait runs out.
// - openai: the desk calls the API itself with the key from its env file.
const TARGET_WAIT_MS = 330_000; // the hub's own runtime budget is 300 s
type TargetReply = { text?: string; error?: string; model?: string };
const targetWait = new Map<string, { done: (r: TargetReply) => void; send: (m: unknown) => void }>();

async function targetTurn(rec: SourceRec, th: { id: string }, m: any, send: (m: unknown) => void) {
  const pick = m.target ?? { id: "hub", ...m.hub }; // m.hub: pages from before targets
  const t: AskTarget | undefined = cfg.askTargets.find((x) => x.id === pick.id);
  if (!t) throw new Error(`no ask target "${pick.id}" (desk.toml [[ask_target]])`);
  const text = String(m.text ?? "").trim();
  if (!text) throw new Error("empty message");
  const agentId = t.kind === "sanatana-hub" ? String(pick.agent || "expert").slice(0, 60) : "";
  const model = String(pick.model || "").slice(0, 120);
  const key = `${rec.id}/${th.id}`;
  if (busy.has(key)) throw new Error("thread busy");
  const ac = new AbortController();
  busy.set(key, ac);
  const pub = (event: any) => bus.publish({ sourceId: rec.id, threadId: th.id, event });
  pub({ kind: "prompt", text: promptTag(t.id, [agentId, model].filter(Boolean).join(" "), th.id, text) });
  try {
    let r: TargetReply;
    if (BROWSER_KINDS.includes(t.kind)) {
      r = await new Promise<TargetReply>((res) => {
        targetWait.set(key, { done: res, send });
        ac.signal.addEventListener("abort", () => res({ error: "cancelled" }));
        setTimeout(() => res({ error: `${t.label} did not answer in time` }), TARGET_WAIT_MS);
        send({ type: "target_go", sourceId: rec.id, threadId: th.id, target: t.id, text, agent: agentId, model });
      });
    } else {
      try {
        const history = targetHistory(bus.since(0), rec.id, th.id, t.id);
        const a = await openaiAsk(t, { input: text, history, model, signal: ac.signal });
        if (a.tokensIn != null && a.tokensOut != null) pub({ kind: "usage", tokensIn: a.tokensIn, tokensOut: a.tokensOut });
        r = { text: a.text || "(empty answer)", model: a.model };
      } catch (e: any) {
        r = { error: ac.signal.aborted ? "cancelled" : String(e?.message ?? e) };
      }
    }
    if (r.text) pub({ kind: "text", text: r.text + signature(t.label, [agentId, r.model].filter(Boolean).join(" · ")) });
    const outcome = r.error === "cancelled" ? "cancelled" : r.error ? "error" : "ok";
    pub({ kind: "done", outcome, ...(outcome === "error" ? { error: `${t.label}: ${r.error}` } : {}) });
  } finally {
    targetWait.delete(key);
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
