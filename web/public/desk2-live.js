// desk2 live mode: the same page, fed by the desk server over /ws instead of the demo data.
// Loaded after desk2.html's own script. If no desk answers (vite preview, file://), the page
// stays on its demo data and says so. In live mode it mutates the page's data tables
// (PLACES, THREADS, NEEDS, FILES, LINKS) in place and replaces out(), diffOf(), send(), act().
(() => {
  "use strict";
  const L = { on: false, ws: null, events: [], lastSeq: 0, sources: [], features: [], files: {}, diffs: {}, review: {}, pair: {}, merge: [], pendingNew: null, retry: 500 };
  window.deskLive = L;
  L.wantFile = new URLSearchParams(location.search).get("file"); // deep link: open once the thread's files arrive
  const tok = () => { try { const t = new URLSearchParams(location.hash.slice(1)).get("token"); if (t) localStorage.setItem("token", t); return t ?? localStorage.getItem("token") ?? undefined; } catch { return undefined; } };
  const wsSend = (m) => { if (L.ws?.readyState === 1) L.ws.send(JSON.stringify(m)); else toast("Not connected to the desk"); };
  const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return !isFinite(s) ? "—" : s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
  const strip = (t) => String(t ?? "").replace(/^\S*\[[^\]]+\]:\s*/, "");
  const evsOf = (src, th) => L.events.filter((e) => e.sourceId === src && e.threadId === th);

  function connect() {
    let ws;
    try { ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); } catch { return demo(); }
    L.ws = ws;
    const giveUp = setTimeout(() => { if (!L.on) demo(); }, 2500);
    ws.onopen = () => clearTimeout(giveUp) || ws.send(JSON.stringify({ type: "hello", token: tok(), lastSeq: L.lastSeq }));
    ws.onmessage = (m) => { clearTimeout(giveUp); onMsg(JSON.parse(m.data)); };
    ws.onclose = () => { if (!L.on) return demo(); toast("Reconnecting to the desk…"); setTimeout(connect, (L.retry = Math.min(L.retry * 2, 10000))); };
  }
  function demo() {
    if (L.demo) return;
    L.demo = true;
    document.querySelector(".brand")?.insertAdjacentHTML("beforeend",  ' <span id="demoPill" class="pill p-mute" title="No desk server answered on /ws: showing made-up data">demo data</span>');
  }

  // ---------- data from the desk ----------
  function threadState(src, th) {
    const ev = evsOf(src, th);
    const open = new Set();
    let st = "idle";
    for (const e of ev) {
      const k = e.event.kind;
      if (k === "approval_request") open.add(e.event.id);
      else if (k === "approval_result") open.delete(e.event.id);
      else if (k === "prompt") st = "working";
      else if (k === "state" && e.event.state) st = e.event.state === "unknown" ? st : e.event.state;
      else if (k === "done") st = e.event.outcome === "ok" ? "done" : "idle";
    }
    return open.size ? "blocked" : st;
  }
  function rebuild() {
    const fs = L.features;
    PLACES.splice(0, PLACES.length, ...L.sources.map((s) => ({
      id: s.id, name: s.id === "general" ? "General" : s.id === "desk-dev" ? "Desk dev" : s.location.split("/").filter(Boolean).pop() || s.id,
      machine: "hp", kind: s.id === "general" ? "general" : "project", deskdev: s.id === "desk-dev", src: s,
    })));
    for (const k of Object.keys(THREADS)) delete THREADS[k];
    NEEDS.splice(0);
    for (const s of L.sources) {
      THREADS[s.id] = Object.values(s.threads).filter((t) => !t.closed || S.thread === t.id).map((t) => {
        const ev = evsOf(s.id, t.id);
        const first = ev.find((e) => e.event.kind === "prompt");
        const ctx = [...ev].reverse().find((e) => e.event.kind === "context");
        const tokens = ev.filter((e) => e.event.kind === "usage").reduce((a, e) => a + (e.event.tokensIn || 0) + (e.event.tokensOut || 0), 0);
        return {
          id: s.id === "general" && t.id === "ask" ? "ask" : t.id,
          title: t.title || (t.id === "ask" ? (s.id === "general" ? "New question" : "Project questions") : strip(first?.event.text).slice(0, 70) || "no messages yet"),
          state: threadState(s.id, t.id), age: ago(ev.at(-1)?.ts ?? t.createdAt),
          kind: s.id === "general" ? undefined : t.mode === "ask" ? "ask" : t.mode,
          desk: s.id === "desk-dev" && t.mode === "code", // Desk perspective
          ctx: ctx ? Math.round((100 * ctx.event.used) / ctx.event.limit) : undefined, tok: tokens ? `${Math.round(tokens / 1000)}k` : "0",
          rec: t,
        };
      }).sort((a, b) => (a.kind === "ask" ? -1 : b.kind === "ask" ? 1 : 0));
      for (const t of THREADS[s.id]) {
        const done = new Set(evsOf(s.id, t.id).filter((e) => e.event.kind === "approval_result").map((e) => e.event.id));
        for (const e of evsOf(s.id, t.id)) if (e.event.kind === "approval_request" && !done.has(e.event.id)) NEEDS.push({ place: s.id, thread: t.id, text: `${t.id} wants to use ${e.event.tool}`, id: e.event.id });
      }
    }
    S.level = fs.includes("self") ? "power" : fs.includes("code") ? "developer" : "everyday";
    S.deskDev = fs.includes("self");
    if (!PLACES.some((p) => p.id === S.place)) { S.place = PLACES[0]?.id ?? "general"; S.thread = null; }
    if (S.thread && !(THREADS[S.place] || []).some((t) => t.id === S.thread)) S.thread = null;
  }
  function refreshThread() {
    const t = thr();
    if (!t || !t.kind || t.kind === "ask") return;
    wsSend({ type: "files", sourceId: S.place, threadId: t.id, base: S.diffBase === "last" ? "last" : "start" });
    if (t.kind === "code") wsSend({ type: "review", sourceId: S.place, threadId: t.id });
  }
  function onMsg(m) {
    if (m.type === "welcome") {
      L.on = true; L.retry = 500; L.demo = false; document.getElementById("demoPill")?.remove(); L.sources = m.sources; L.features = m.features ?? [];
      rebuild(); render();
      for (const p of PLACES) if (p.kind === "project" && L.features.includes("design")) wsSend({ type: "links", sourceId: p.id });
      if (L.features.includes("code")) wsSend({ type: "merge_list" });
      S.deskDev = L.features.includes("self"); // the server decides who sees the desk's own code
      if (S.deskDev) wsSend({ type: "desk_state" }); else { DESK.applies = []; DESK.previews = []; }
      refreshThread();
    } else if (m.type === "sources") {
      const before = new Set(L.sources.flatMap((s) => Object.keys(s.threads).map((t) => `${s.id}/${t}`)));
      L.sources = m.sources; rebuild();
      if (L.pendingNew) {
        const s = L.sources.find((x) => x.id === L.pendingNew.place);
        const fresh = s && Object.keys(s.threads).find((t) => !before.has(`${s.id}/${t}`));
        if (fresh) { const p = L.pendingNew; L.pendingNew = null; S.thread = fresh; wsSend({ type: "prompt", sourceId: p.place, threadId: fresh, text: p.text }); }
      }
      render();
    } else if (m.type === "event") {
      if (m.e.seq <= L.lastSeq && L.events.some((x) => x.seq === m.e.seq)) return;
      L.events.push(m.e); L.lastSeq = Math.max(L.lastSeq, m.e.seq);
      clearTimeout(L.rt); L.rt = setTimeout(() => { rebuild(); renderTree(); renderMid(); if (m.e.event.kind === "done") refreshThread(); }, 60);
    } else if (m.type === "focus") {
      S.place = m.sourceId; S.thread = m.threadId; render();
    } else if (m.type === "files") {
      FILES[m.threadId] = m.files.map((f) => ({ path: f.path, st: f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M", a: f.added, d: f.removed, design: /\.html?$/.test(f.path) && m.threadId.startsWith("design"), kind: f.kind }));
      for (const k of Object.keys(L.diffs)) if (k.startsWith(m.threadId + "|")) delete L.diffs[k];
      if (L.wantFile && m.threadId === S.thread && FILES[m.threadId].some((f) => f.path === L.wantFile)) { S.file = L.wantFile; L.wantFile = null; layout(); }
      renderFiles(); renderRight();
    } else if (m.type === "file_diff") {
      L.diffs[`${m.threadId}|${m.path}|${S.diffBase}`] = parseDiff(m.diff); renderRight();
    } else if (m.type === "review") {
      L.review[m.threadId] = m.review; renderMid();
    } else if (m.type === "links") {
      LINKS.splice(0, LINKS.length, ...LINKS.filter((l) => l[3] !== m.sourceId), ...m.links.map((l) => [l.a, l.b, l.why, m.sourceId]));
      renderTree(); renderMid();
    } else if (m.type === "pair") {
      L.pair[m.sourceId] = m.pair;
      if (m.attach) toast(`Pair open in herdr: ${m.attach.join(" ")}`);
    } else if (m.type === "pair_review") {
      toast("Reviewer asked to check the current diff");
    } else if (m.type === "desk") {
      DESK.applies = m.applies; DESK.previews = m.previews;
      if (S.persp === "desk") renderMid();
    } else if (m.type === "merge_queue") {
      L.merge = m.items; renderMid();
    } else if (m.type === "error") {
      toast(m.error);
    }
  }
  Object.assign(REL_BACK, { "started from": "started from", mentions: "mentions" });

  // ---------- rendering overrides ----------
  function parseDiff(text) {
    const rows = [];
    for (const l of String(text).split("\n")) {
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
      if (l.startsWith("@@")) rows.push(["@@", l.replace(/^@@\s?/, "")]);
      else if (l.startsWith("+")) rows.push(["+", l.slice(1)]);
      else if (l.startsWith("-")) rows.push(["-", l.slice(1)]);
      else if (l.startsWith(" ")) rows.push([" ", l.slice(1)]);
    }
    return rows.length ? rows : [["@@", "no changes"]];
  }
  const liveDiffOf = (f) => {
    const owner = S.fileOwner ?? thr()?.id, k = `${owner}|${f.path}|${S.diffBase}`;
    if (L.diffs[k]) return L.diffs[k];
    if (!L.diffs[k + "?"]) { L.diffs[k + "?"] = 1; wsSend({ type: "file_diff", sourceId: S.place, threadId: owner, path: f.path, base: S.diffBase === "last" ? "last" : "start" }); }
    return [["@@", "loading diff…"]];
  };
  const md = (s) => esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  function turns(src, th) {
    // Newest first: each of your messages followed by the builder's reply.
    const out = [];
    let cur = null;
    for (const e of evsOf(src, th)) {
      const v = e.event;
      if (v.kind === "prompt") { cur = { me: strip(v.text), raw: v.text, text: "", steps: [], asks: [], resolved: new Set(), state: "working", ts: e.ts }; out.push(cur); continue; }
      if (!cur) { cur = { me: null, text: "", steps: [], asks: [], resolved: new Set(), state: "working", ts: e.ts }; out.push(cur); }
      if (v.kind === "text") cur.text += v.text;
      else if (v.kind === "tool_call") cur.steps.push({ id: v.id, name: v.name, input: v.input, ok: null });
      else if (v.kind === "tool_result") { const s = cur.steps.find((x) => x.id === v.id); if (s) s.ok = !v.isError; }
      else if (v.kind === "approval_request") cur.asks.push(v);
      else if (v.kind === "approval_result") cur.resolved.add(v.id);
      else if (v.kind === "done") { cur.state = v.outcome === "ok" ? "done" : v.outcome; cur.error = v.error; }
    }
    return out.reverse();
  }
  const stepLabel = (s) => { const i = s.input || {}; const f = i.file_path || i.path || i.command || i.pattern || i.url || ""; return `${s.name}${f ? " " + String(f).slice(0, 90) : ""}`; };
  function liveOut(t) {
    if (!t) return demoOut(t);
    const p = place(), ts = turns(S.place, t.id), rv = L.review[t.id], q = L.merge.find((i) => i.sourceId === S.place && i.threadId === t.id && i.state !== "merged");
    const who = p.kind === "general" ? "Claude" : "Builder";
    const html = ts.map((u, i) => {
      const steps = u.steps.length ? `<details class="fold"><summary>${u.steps.length} steps${u.steps.some((s) => s.ok === false) ? " · some failed" : ""}</summary><div class="fb">${u.steps.slice(-40).map((s) => `<div class="step"><span class="ok">${s.ok === false ? "✗" : s.ok ? "✓" : "…"}</span>${esc(stepLabel(s))}</div>`).join("")}</div></details>` : "";
      const asks = u.asks.filter((a) => !u.resolved.has(a.id)).map((a) => `<div class="ask"><div>Wants to use <code>${esc(a.tool)}</code>: <code>${esc(JSON.stringify(a.input).slice(0, 200))}</code></div><div class="acts"><button class="btn pri sm" data-approve="${esc(a.id)}|1">Allow</button><button class="btn sm" data-approve="${esc(a.id)}|0">Deny</button></div></div>`).join("");
      const review = i === 0 && rv && rv.state !== "none" && t.kind === "code" ? `<details class="fold dev"><summary><span class="dot" style="background:${rv.state === "clean" ? "var(--ok)" : "var(--amber)"}"></span>${esc(rv.text)}</summary><div class="fb">${rv.findings.map((f) => `<div class="rvl"><span class="sev ${f.severity === "medium" ? "med" : f.severity}">${f.severity === "medium" ? "med" : f.severity}</span><span>${f.file ? `<code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code> ` : ""}${esc(f.text)} <b ${f.status === "verified" ? 'style="color:var(--ok)"' : f.status === "disputed" ? 'class="needs"' : ""}>${{ verified: "Fixed, re-checked.", claimed: "Builder says fixed; reviewer to re-check.", open: "Open.", disputed: "Disputed.", wontfix: "Won't fix." }[f.status]}</b>${f.note ? ` <span class="mute">${esc(f.note)}</span>` : ""}</span></div>`).join("")}<span class="mute" style="font-size:11.5px">Written by the desk from the reviewer's verdict file, not by the builder.</span></div></details>` : "";
      const merge = i === 0 && q ? `<div class="mute" style="font-size:12.5px">Merge queue: <b>${esc(q.state)}</b>${q.reason ? " · " + esc(q.reason) : ""}</div>` : "";
      if (u.error && !u.text.includes(u.error)) u.text += (u.text ? "\n\n" : "") + `⚠ ${u.state === "cancelled" ? "Stopped" : "Error"}: ${u.error}`;
      const reply = u.text || u.steps.length || u.asks.length ? `<div class="turn"><div class="who"><span class="dot s-${u.state === "working" ? t.state : u.state === "done" ? "done" : "idle"}"></span><b>${who}</b>${u.asks.some((a) => !u.resolved.has(a.id)) ? '<span class="needs">· needs you</span>' : ""}<span class="meta">· ${ago(u.ts)}</span></div><div class="body">${u.text ? `<div>${md(u.text)}</div>` : ""}${steps}${review}${asks}${merge}</div></div>` : u.state === "working" ? `<div class="turn"><div class="who"><span class="dot s-working"></span><b>${who}</b><span class="meta">· working…</span></div></div>` : "";
      const me = u.me != null ? `<div class="turn me"><div class="who">you <span class="mono dev">${esc((u.raw.match(/^\S*\[[^\]]+\]/) || [""])[0])}</span></div><div class="body">${md(u.me)}</div></div>` : "";
      return reply + me;
    }).join("");
    if (!html && rv && rv.state !== "none") return `<div class="out"><div class="turn"><div class="who"><b>Review</b></div><div class="body"><div>${esc(rv.text)}</div></div></div></div>`;
    return `<div class="out">${html || `<div class="empty"><b style="color:var(--fg)">${esc(t.title)}</b><span>No turns yet. Type above.</span></div>`}</div>`;
  }
  function liveSend() {
    const ta = $("msg"), v = ta?.value.trim();
    if (!v) return toast("Type a message");
    const t = thr();
    if (!t) {
      if (S.place === "general") wsSend({ type: "prompt", sourceId: "general", threadId: "ask", text: v });
      else {
        const kind = document.querySelector('[data-sel="newKind"]')?.value ?? "ask";
        if (kind === "ask") { S.thread = "ask"; wsSend({ type: "prompt", sourceId: S.place, threadId: "ask", text: v }); }
        else { L.pendingNew = { place: S.place, text: v }; wsSend({ type: "thread", sourceId: S.place, mode: kind, from: S.relFrom || undefined }); }
      }
    } else {
      const mail = v.match(/^@((?:code|design)-\d+)\s+([\s\S]+)$/); // "@code-2 I changed the API": mailbox to that thread's builder
      if (mail && t.kind) wsSend({ type: "mail", sourceId: S.place, from: t.id, to: mail[1], text: mail[2] });
      else wsSend({ type: "prompt", sourceId: S.place, threadId: t.id, text: v });
    }
    ta.value = "";
  }
  function liveAct(a, el) {
    const t = thr(), ids = { sourceId: S.place, threadId: t?.id };
    switch (a) {
      case "stop": return wsSend({ type: "cancel", ...ids });
      case "terminal": return wsSend({ type: "pair_open", ...ids });
      case "reviewNow": return wsSend({ type: "pair_review", ...ids });
      case "merge": return wsSend({ type: "merge_enqueue", ...ids });
      case "preview": return wsSend({ type: "desk_preview", ...ids });
      case "previewStop": return wsSend({ type: "desk_preview", ...ids, stop: true });
      case "deskRevert": return wsSend({ type: "desk_revert", id: Number(el?.dataset.deskRevert) });
      case "close": closeMenu(); return wsSend({ type: "close", ...ids });
      case "compact": closeMenu(); return wsSend({ type: "prompt", ...ids, text: "/compact" });
      case "needs": { const n = NEEDS[0]; return n ? go(n.place, n.thread) : toast("Nothing needs you"); }
      case "allow": case "deny": case "allowAlways": { const n = NEEDS.find((x) => x.place === S.place && x.thread === t?.id); if (!n) return toast("No open approval"); return wsSend({ type: "approve", id: n.id, allow: a !== "deny" }); }
    }
    return demoAct(a, el);
  }

  const demoOut = out, demoAct = act, demoGo = go;
  out = (t) => (L.on ? liveOut(t) : demoOut(t));
  diffOf = ((d) => (f) => (L.on ? liveDiffOf(f) : d(f)))(diffOf);
  send = ((d) => () => (L.on ? liveSend() : d()))(send);
  act = (a, el) => (L.on ? liveAct(a, el) : demoAct(a, el));
  go = (p, t) => { const r = demoGo(p, t); if (L.on) refreshThread(); return r; };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-approve], [data-base], [data-cmd]");
    if (!b || !L.on) return;
    if (b.dataset.approve) { const [id, ok] = b.dataset.approve.split("|"); wsSend({ type: "approve", id, allow: ok === "1" }); }
    else if (b.dataset.base) setTimeout(refreshThread, 0);
    else if (b.dataset.cmd && b.dataset.cmd !== "/<command>" && thr()) { e.stopImmediatePropagation(); closeMenu(); wsSend({ type: "prompt", sourceId: S.place, threadId: thr().id, text: b.dataset.cmd }); }
  }, true);
  connect();
})();
