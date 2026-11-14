// desk2 live mode: the same page, fed by the desk server over /ws instead of the demo data.
// Loaded after desk2.html's own script. If no desk answers (vite preview, file://), the page
// stays on its demo data and says so. In live mode it mutates the page's data tables
// (PLACES, THREADS, NEEDS, FILES, LINKS) in place and replaces out(), diffOf(), send(), act().
// desk2-extras.ts (a module, so it runs before DOMContentLoaded) brings the terminal,
// alerts, Ask targets and dialogs as window.deskExtras; we connect after it, on DOMContentLoaded.
(() => {
  "use strict";
  const L = { on: false, ws: null, events: [], lastSeq: 0, sources: [], features: [], files: {}, diffs: {}, review: {}, pair: {}, merge: [], pendingNew: null, retry: 500,
    role: null, notes: {}, notesDate: new Date().toISOString().slice(0, 10), usage: null, usageRange: "7d", hits: null, claude: null, atts: [], browse: null, prefill: null };
  const X = () => window.deskExtras; // shared modules (desk2-extras.ts); absent in a plain static preview
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
    const places = L.sources.filter((s) => s.id !== "compute"); // the Compute chat lives in the Compute perspective
    PLACES.splice(0, PLACES.length, ...places.map((s) => ({
      id: s.id, name: s.id === "general" ? "General" : s.id === "desk-dev" ? "Desk dev" : s.location.split("/").filter(Boolean).pop() || s.id,
      machine: "hp", kind: s.id === "general" ? "general" : "project", deskdev: s.id === "desk-dev", src: s,
    })));
    for (const k of Object.keys(THREADS)) delete THREADS[k];
    NEEDS.splice(0);
    for (const s of places) {
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
        for (const e of evsOf(s.id, t.id)) if (e.event.kind === "approval_request" && !done.has(e.event.id)) NEEDS.push({ place: s.id, thread: t.id, text: `${t.id} wants to use ${e.event.tool}`, id: e.event.id, options: e.event.options });
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
    if (m.type !== "welcome" && X()?.onMsg(m, L.events)) return;
    if (m.type === "welcome") {
      L.on = true; L.retry = 500; L.demo = false; document.getElementById("demoPill")?.remove(); L.sources = m.sources; L.features = m.features ?? []; L.role = m.role; L.guestAsk = !!m.guestAsk; L.targets = m.targets ?? []; L.keyword = m.keyword;
      X()?.connect(wsSend, () => L.role === "action", m);
      document.getElementById("roPill")?.remove();
      if (m.role !== "action") document.querySelector(".brand")?.insertAdjacentHTML("beforeend", ' <button id="roPill" class="pill p-amber" data-act="signin" title="This browser has no desk token: you can read, not act">read-only · sign in</button>');
      L.prefill ??= X()?.takePrefill() ?? null; // shared text or link: into the composer, never sent by itself
      if (L.prefill) { S.place = L.sources.some((x) => x.id === L.prefill.source) ? L.prefill.source : "general"; S.thread = S.place === "general" ? null : "ask"; S.view = "thread"; }
      rebuild(); render();
      for (const p of PLACES) if (p.kind === "project" && L.features.includes("design")) wsSend({ type: "links", sourceId: p.id });
      if (L.features.includes("code")) wsSend({ type: "merge_list" });
      S.deskDev = L.features.includes("self"); // the server decides who sees the desk's own code
      if (S.deskDev) wsSend({ type: "desk_state" }); else { DESK.applies = []; DESK.previews = []; }
      S.compute = L.features.includes("compute") && m.role === "action"; // admin with the desk token
      COMPUTE.machines = []; COMPUTE.out = {}; COMPUTE.error = "";
      if (S.compute) wsSend({ type: "compute_state" });
      refreshThread();
      if (L.prefill) { const ta = $("msg"); if (ta) { ta.value = L.prefill.text; ta.focus(); } L.prefill = false; }
      openHash(location.hash);
    } else if (m.type === "sources") {
      const before = new Set(L.sources.flatMap((s) => Object.keys(s.threads).map((t) => `${s.id}/${t}`)));
      L.sources = m.sources; rebuild();
      if (L.attaching) {
        const loc = L.attaching.replace(/\/+$/, ""), s2 = L.sources.find((x) => x.location === loc || x.location.endsWith(loc.replace(/^~/, "")));
        if (s2 && !before.has(`${s2.id}/ask`)) { L.attaching = null; toast(`Added ${s2.id}`); S.view = "thread"; S.place = s2.id; S.thread = "ask"; }
      }
      if (L.pendingNew) {
        const s = L.sources.find((x) => x.id === L.pendingNew.place);
        const fresh = s && Object.keys(s.threads).find((t) => !before.has(`${s.id}/${t}`));
        if (fresh) { const p = L.pendingNew; L.pendingNew = null; S.thread = fresh; wsSend({ type: "prompt", sourceId: p.place, threadId: fresh, text: p.text, ...(p.extra ?? {}) }); }
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
      if (L.wantTerm === m.sourceId && L.features.includes("terminal") && X()) { L.wantTerm = null; X().openTerminal(m.pair.session); }
      else if (m.attach) toast(`Pair open in herdr: ${m.attach.join(" ")}`);
    } else if (m.type === "pair_review") {
      toast("Reviewer asked to check the current diff");
    } else if (m.type === "notes") {
      L.notes[m.date] = m.rows; if (S.view === "notes") renderMid();
    } else if (m.type === "usage") {
      L.usage = m; if (S.view === "usage") renderMid();
    } else if (m.type === "search") {
      if (m.q === (S.q ?? "").trim()) { L.hits = m.hits; L.hitsFor = m.q; L.hitsAsked = null; if (S.view === "history") drawHits(); }
    } else if (m.type === "ls") {
      if (m.tag === "browse") { L.browse = { dir: m.dir, entries: m.entries }; drawBrowse(); }
      else if ($("attLoc")?.value === m.path) $("attLocs").innerHTML = m.entries.map((v) => `<option value="${esc(v)}">`).join("");
    } else if (m.type === "sessions") {
      if (m.sourceId === S.place) { L.claude = m.sessions; if (S.view === "resume") renderMid(); }
    } else if (m.type === "compute") {
      COMPUTE.machines = m.machines; COMPUTE.error = m.error ?? "";
      if (!m.machines.some((x) => x.id === COMPUTE.sel)) COMPUTE.sel = m.machines[0]?.id ?? null;
      if (S.persp === "compute") { renderTree(); renderMid(); }
      renderPersp();
    } else if (m.type === "compute_out") {
      (COMPUTE.out[m.id] ||= []).unshift(m); COMPUTE.out[m.id].length = Math.min(COMPUTE.out[m.id].length, 6);
      toast(`${m.label}: ${m.ok ? "done" : "failed"}`);
      if (S.persp === "compute") renderMid();
      if (m.ok && /^(ha|vps|wol)/.test(m.action)) setTimeout(() => wsSend({ type: "compute_state" }), 5000); // power changed: look again
    } else if (m.type === "desk") {
      DESK.applies = m.applies; DESK.previews = m.previews;
      if (S.persp === "desk") renderMid();
    } else if (m.type === "merge_queue") {
      L.merge = m.items; renderMid();
    } else if (m.type === "error") {
      toast(m.error);
      if (L.sent && Date.now() - L.sent.at < 10000) { const ta = $("msg"); if (ta && !ta.value.trim()) ta.value = L.sent.text; L.sent = null; } // rejected prompt: give the text back
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
    const who0 = p.kind === "general" ? "Claude" : "Builder";
    const html = ts.map((u, i) => {
      const steps = u.steps.length ? `<details class="fold"><summary>${u.steps.length} steps${u.steps.some((s) => s.ok === false) ? " · some failed" : ""}</summary><div class="fb">${u.steps.slice(-40).map((s) => `<div class="step"><span class="ok">${s.ok === false ? "✗" : s.ok ? "✓" : "…"}</span>${esc(stepLabel(s))}</div>`).join("")}</div></details>` : "";
      const asks = u.asks.filter((a) => !u.resolved.has(a.id)).map((a) => `<div class="ask"><div>Wants to use <code>${esc(a.tool)}</code>: <code>${esc(JSON.stringify(a.input).slice(0, 200))}</code></div><div class="acts">${a.options
        // A live Claude window's own prompt brings its options, answered by key; the desk's own approvals are Allow/Deny.
        ? a.options.map((o) => `<button class="btn sm${o.allow ? " pri" : ""}" data-lans="${esc(t.id)}|${esc(a.id)}|${esc(o.key)}">${esc(o.label)}</button>`).join("")
        : `<button class="btn pri sm" data-approve="${esc(a.id)}|1">Allow</button><button class="btn sm" data-approve="${esc(a.id)}|0">Deny</button>`}</div></div>`).join("");
      const review = i === 0 && rv && rv.state !== "none" && t.kind === "code" ? `<details class="fold dev"><summary><span class="dot" style="background:${rv.state === "clean" ? "var(--ok)" : "var(--amber)"}"></span>${esc(rv.text)}</summary><div class="fb">${rv.findings.map((f) => `<div class="rvl"><span class="sev ${f.severity === "medium" ? "med" : f.severity}">${f.severity === "medium" ? "med" : f.severity}</span><span>${f.file ? `<code>${esc(f.file)}${f.line ? ":" + f.line : ""}</code> ` : ""}${esc(f.text)} <b ${f.status === "verified" ? 'style="color:var(--ok)"' : f.status === "disputed" ? 'class="needs"' : ""}>${{ verified: "Fixed, re-checked.", claimed: "Builder says fixed; reviewer to re-check.", open: "Open.", disputed: "Disputed.", wontfix: "Won't fix." }[f.status]}</b>${f.note ? ` <span class="mute">${esc(f.note)}</span>` : ""}</span></div>`).join("")}<span class="mute" style="font-size:11.5px">Written by the desk from the reviewer's verdict file, not by the builder.</span></div></details>` : "";
      const merge = i === 0 && q ? `<div class="mute" style="font-size:12.5px">Merge queue: <b>${esc(q.state)}</b>${q.reason ? " · " + esc(q.reason) : ""}</div>` : "";
      if (u.error && !u.text.includes(u.error)) u.text += (u.text ? "\n\n" : "") + `⚠ ${u.state === "cancelled" ? "Stopped" : "Error"}: ${u.error}`;
      const tag = (u.raw.match(/^(\S+?):?\[/) || [])[1], tgt = tag && tag !== L.keyword && L.targets.find((x) => x.id === tag);
      const who = tgt ? tgt.label : who0; // a General question asked of another target ("Run on")
      const reply = u.text || u.steps.length || u.asks.length ? `<div class="turn"><div class="who"><span class="dot s-${u.state === "working" ? t.state : u.state === "done" ? "done" : "idle"}"></span><b>${who}</b>${u.asks.some((a) => !u.resolved.has(a.id)) ? '<span class="needs">· needs you</span>' : ""}<span class="meta">· ${ago(u.ts)}</span></div><div class="body">${u.text ? `<div>${md(u.text)}</div>` : ""}${steps}${review}${asks}${merge}</div></div>` : u.state === "working" ? `<div class="turn"><div class="who"><span class="dot s-working"></span><b>${who}</b><span class="meta">· working…</span></div></div>` : "";
      const me = u.me != null ? `<div class="turn me"><div class="who">you <span class="mono dev">${esc((u.raw.match(/^\S*\[[^\]]+\]/) || [""])[0])}</span></div><div class="body">${meBody(u.me)}</div></div>` : "";
      return reply + me;
    }).join("");
    if (!html && rv && rv.state !== "none") return `<div class="out"><div class="turn"><div class="who"><b>Review</b></div><div class="body"><div>${esc(rv.text)}</div></div></div></div>`;
    return `<div class="out">${html || `<div class="empty"><b style="color:var(--fg)">${esc(t.title)}</b><span>No turns yet. Type above.</span></div>`}</div>`;
  }
  function liveSend() {
    const ta = $("msg"), v = ta?.value.trim();
    if (!v) return toast("Type a message");
    const at = /^\s*attach:\s*(\S+)\s*$/i.exec(v); // "attach: <name>" opens that herdr session
    if (at) {
      if (L.role !== "action") return toast("Read-only: sign in to attach");
      if (!L.features.includes("sessions")) return toast("Sessions are not part of your profile");
      X()?.attachByName(at[1]); ta.value = ""; return;
    }
    if (L.role !== "action") {
      // Read-only guest: the desk only takes questions to a browser-side Run on target in General.
      if (!L.guestAsk) return toast("Read-only: sign in to send");
      if (S.place !== "general") return toast("Guests can ask in General");
      const target = X()?.targetChoice(v);
      if (!X()?.isBrowserTarget(target?.id)) return toast("Read-only: pick a Run on target other than This host");
      L.sent = { text: v, at: Date.now() };
      wsSend({ type: "prompt", sourceId: "general", threadId: thr()?.id ?? "ask", text: v, target });
      ta.value = ""; return;
    }
    if (L.atts.some((a) => !a.path && !a.failed)) return toast("Still uploading…");
    const t = thr();
    // Extras every prompt carries: attachments (uploaded for this place), where Ask runs (General), a session PIN.
    const attachments = L.atts.filter((a) => a.path && a.source === S.place).map((a) => a.path);
    const hs = place().src?.herdrSession;
    const extra = { attachments: attachments.length ? attachments : undefined, pin: hs ? X()?.pinFor(hs) : undefined };
    L.sent = { text: v, at: Date.now() };
    if (!t) {
      if (S.place === "general") wsSend({ type: "prompt", sourceId: "general", threadId: "ask", text: v, target: X()?.targetChoice(v), ...extra });
      else {
        const kind = document.querySelector('[data-sel="newKind"]')?.value ?? "ask";
        if (kind === "ask") { S.thread = "ask"; wsSend({ type: "prompt", sourceId: S.place, threadId: "ask", text: v, ...extra }); }
        else { L.pendingNew = { place: S.place, text: v, extra }; wsSend({ type: "thread", sourceId: S.place, mode: kind, from: S.relFrom || undefined }); }
      }
    } else {
      const mail = v.match(/^@((?:code|design)-\d+)\s+([\s\S]+)$/); // "@code-2 I changed the API": mailbox to that thread's builder
      if (mail && t.kind) wsSend({ type: "mail", sourceId: S.place, from: t.id, to: mail[1], text: mail[2] });
      else wsSend({ type: "prompt", sourceId: S.place, threadId: t.id, text: v, target: S.place === "general" ? X()?.targetChoice(v) : undefined, ...extra });
    }
    ta.value = "";
    L.atts = [];
    L.keep = null;
  }
  function liveAct(a, el) {
    const t = thr(), ids = { sourceId: S.place, threadId: t?.id };
    switch (a) {
      case "stop": return wsSend({ type: "cancel", ...ids });
      case "reviewNow": return wsSend({ type: "pair_review", ...ids });
      case "merge": return wsSend({ type: "merge_enqueue", ...ids });
      case "terminal": L.wantTerm = S.place; return wsSend({ type: "pair_open", ...ids }); // pair in herdr, shown in the terminal panel
      case "terminalPanel": closeMenu(); return X() ? X().toggleTerminal() : toast("Terminal needs the built desk (npm run build)");
      case "sessions": closeMenu(); return X()?.showHSessions();
      case "schedules": closeMenu(); return X()?.showSchedules();
      case "settings": case "pair": closeMenu(); return X() ? X().showAgents() : toast("Settings needs the built desk (npm run build)");
      case "health": closeMenu(); return X()?.health();
      case "alerts": closeMenu(); return X()?.togglePush();
      case "attach": return $("attFile").click();
      case "browse": { const v = $("attLoc").value.trim(); return wsSend({ type: "ls", tag: "browse", path: v ? (v.endsWith("/") ? v : v.slice(0, v.lastIndexOf("/") + 1) || "~/") : "~/", limit: 500 }); }
      case "pickDir": $("attLoc").value = L.browse?.dir ?? ""; L.browse = null; return drawBrowse();
      case "attachGo": {
        const loc = $("attLoc").value.trim(), url = S.akind === "url";
        if (!loc) return toast(url ? "Type a URL" : "Type or browse to a folder");
        if (url) { if (!/^https?:\/\//.test(loc)) return toast("URL must start with http(s)://"); lsSet("urls", JSON.stringify([loc, ...urls().filter((u) => u !== loc)].slice(0, 20))); }
        L.attaching = loc; return wsSend({ type: "attach", location: loc });
      }
      case "resume": closeMenu(); L.claude = null; wsSend({ type: "sessions", sourceId: S.place }); return view("resume");
      case "signin": return view("signin");
      case "signinGo": { const v = $("tokIn")?.value.trim(); if (!v) return toast("Paste the desk token"); lsSet("token", v); S.view = "thread"; L.ws?.close(); return toast("Signing in…"); }
      case "note": { const ta = $("noteTa"), v = ta?.value.trim(); if (!v) return toast("Type a note"); L.notesDate = today(); delete L.notes[L.notesDate]; wsSend({ type: "note", text: v }); ta.value = ""; return; }
      case "notesPrev": case "notesNext": case "notesToday": L.notesDate = a === "notesToday" ? today() : day(L.notesDate, a === "notesPrev" ? -1 : 1); return renderMid();
      case "preview": return wsSend({ type: "desk_preview", ...ids });
      case "previewStop": return wsSend({ type: "desk_preview", ...ids, stop: true });
      case "deskRevert": return wsSend({ type: "desk_revert", id: Number(el?.dataset.deskRevert) });
      case "close": closeMenu(); return wsSend({ type: "close", ...ids });
      case "compact": closeMenu(); return wsSend({ type: "prompt", ...ids, text: "/compact" });
      case "needs": { const n = NEEDS[0]; return n ? go(n.place, n.thread) : toast("Nothing needs you"); }
      case "allow": case "deny": case "allowAlways": { const n = NEEDS.find((x) => x.place === S.place && x.thread === t?.id); if (!n) return toast("No open approval");
        if (n.options) { const o = n.options.find((x) => x.allow === (a !== "deny")); return o ? wsSend({ type: "live_answer", sourceId: n.place, threadId: n.thread, id: n.id, key: o.key }) : toast("Pick an option in the thread"); }
        return wsSend({ type: "approve", id: n.id, allow: a !== "deny" }); }
    }
    return demoAct(a, el);
  }

  // ---------- views: notes, usage, history, add project, resume, sign in ----------
  const today = () => new Date().toISOString().slice(0, 10);
  const day = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const urls = () => { try { return JSON.parse(localStorage.getItem("urls") ?? "[]"); } catch { return []; } };
  const nameOf = (id) => PLACES.find((p) => p.id === id)?.name ?? id;
  const hm = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  function meBody(text) {
    const sp = X()?.splitAttached(text, S.place) ?? { text, files: [] };
    return md(sp.text) + (sp.files.length ? `<div class="atts">${sp.files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${f.image ? `<img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy">` : "📄 " + esc(f.name)}</a>`).join("")}</div>` : "");
  }
  function liveNotes() {
    const d = L.notesDate, rows = L.notes[d];
    if (rows === undefined && L.notesAsked !== d) { L.notesAsked = d; wsSend({ type: "notes", date: d }); }
    const shown = (rows ?? []).filter((r) => r.kind !== "prompt");
    const row = (r) => `<div class="turn" style="max-width:none"><div class="who"><span class="mono">${hm(r.ts)}</span><b>${esc(r.source_id ? `${nameOf(r.source_id)} / ${r.thread_id}` : "you")}</b><span class="meta">${esc(r.kind)}</span></div><div class="body" style="padding:8px 12px">${
      r.kind === "response" ? `${r.prompt ? `<div class="mute">${esc(r.prompt.slice(0, 200))}</div>` : ""}<div>${md(r.summary ?? "")}</div>${r.files_changed?.length ? `<div class="mute" style="font-size:12px">files: ${esc(r.files_changed.join(", "))}</div>` : ""}<div class="mute" style="font-size:12px">${[r.outcome, r.duration_ms != null ? (r.duration_ms / 1000).toFixed(1) + " s" : "", `${r.tokens_in ?? 0}/${r.tokens_out ?? 0} tok`, r.cost != null ? "$" + r.cost.toFixed(4) : ""].filter(Boolean).join(" · ")}</div>`
      : r.kind === "tool" || r.kind === "approval" ? `<span class="mono">${esc(r.tool ?? "")}</span> ${esc(r.detail ?? "")}` : md(r.summary ?? "")}</div></div>`;
    return vhead("Notes", d === today() ? "today, all places" : d) + `<div class="box"><div class="vform">
      <div class="crow"><div class="seg"><button data-act="notesPrev" title="Day before">‹</button><button data-act="notesToday" class="${d === today() ? "on" : ""}">${d === today() ? "Today" : d}</button><button data-act="notesNext" title="Day after">›</button></div></div>
      <textarea id="noteTa" class="inp" style="height:auto;min-height:64px;padding:8px 10px" placeholder="Add a note (turns are recorded automatically)"></textarea>
      <div class="crow"><span class="sp"></span><button class="btn pri" data-act="note">Add note</button></div></div></div>
      <div class="out">${rows === undefined ? '<div class="mute">Loading…</div>' : shown.length ? shown.slice().reverse().map(row).join("") : `<div class="empty"><span>Nothing on ${d}. Every turn is recorded here; add your own notes above.</span></div>`}</div>`;
  }
  function liveUsage() {
    const u = L.usage, r = L.usageRange;
    if ((!u || u.range !== r) && L.usageAsked !== r) { L.usageAsked = r; wsSend({ type: "usage", range: r }); }
    const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
    const rows = u && u.range === r ? [...u.rows].sort((a, b) => b.costUsd - a.costUsd || b.tokensIn + b.tokensOut - a.tokensIn - a.tokensOut) : null;
    return vhead("Usage", { today: "today", "7d": "last 7 days", all: "all time" }[r]) + `<div class="box"><div class="vform"><div class="seg">${[["today", "Today"], ["7d", "7 days"], ["all", "All time"]].map(([k, l]) => `<button class="${r === k ? "on" : ""}" data-urange="${k}">${l}</button>`).join("")}</div></div></div>
      <div class="out"><div class="turn" style="max-width:720px"><div class="body">${!rows ? '<span class="mute">Loading…</span>' : !rows.length ? '<span class="mute">No turns in this range.</span>' :
        rows.map((x) => `<div style="display:flex;gap:12px"><b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(x.sourceId))} <span class="mono mute">${esc(x.threadId)}</span></b><span class="mono mute">${x.turns} turns</span><span class="mono">${fmt(x.tokensIn + x.tokensOut)}</span><span class="mono mute" style="width:64px;text-align:right">$${x.costUsd.toFixed(2)}</span></div>`).join("") +
        `<div style="display:flex;gap:12px;border-top:1px solid var(--line);padding-top:6px;margin-top:4px"><b style="flex:1">Total</b><span class="mono mute">${u.total.turns} turns</span><span class="mono">${fmt(u.total.tokensIn + u.total.tokensOut)}</span><span class="mono" style="width:64px;text-align:right">$${u.total.costUsd.toFixed(2)}</span></div>`}</div></div></div>`;
  }
  function liveHistory() {
    return vhead("History", "every turn, all places") + `<div class="box"><div class="vform"><input id="histQ" class="inp" placeholder="Search prompts, answers, tool output…" value="${esc(S.q ?? "")}" /></div></div><div class="out" id="hits"></div>`;
  }
  function drawHits() {
    const el = $("hits");
    if (!el) return;
    const q = (S.q ?? "").trim();
    if (!q) { el.innerHTML = '<div class="empty"><span>Type to search everything the desk recorded.</span></div>'; return; }
    if (L.hits === null || L.hitsFor !== q) { el.innerHTML = '<div class="mute">Searching…</div>'; if (L.hitsAsked !== q) { L.hitsAsked = q; wsSend({ type: "search", q }); } return; }
    el.innerHTML = L.hits.length ? `<div class="blist">${L.hits.map((h) => { const sn = h.snippet; return `<button class="hit" data-go="${esc(h.sourceId)}|${esc(h.threadId)}"><b class="mono">${esc(h.threadId)}</b><span>${esc(sn.slice(0, h.start))}<mark>${esc(sn.slice(h.start, h.start + h.len))}</mark>${esc(sn.slice(h.start + h.len))}</span><span class="m">${esc(nameOf(h.sourceId))} · ${esc(h.kind)} · ${esc(String(h.ts).slice(0, 10))}</span></button>`; }).join("")}</div>` : `<div class="empty"><span>Nothing found for “${esc(q)}”.</span></div>`;
  }
  function drawBrowse() {
    const el = $("attBrowse");
    if (!el) return;
    const b = L.browse;
    if (!b) { el.innerHTML = ""; return; }
    const trimmed = b.dir.replace(/\/+$/, ""), parent = trimmed ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : "";
    el.innerHTML = `<div class="crow" style="margin-bottom:6px"><span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(b.dir)}</span><button class="btn sm pri" data-act="pickDir">Select this folder</button></div>
      <div class="blist">${parent ? `<button data-bdir="${esc(parent)}">..</button>` : ""}${b.entries.map((p) => `<button data-bdir="${esc(p)}">${esc(p.slice(b.dir.length))}</button>`).join("") || '<span class="mute" style="padding:8px 10px">No folders here.</span>'}</div>`;
  }
  function liveResume() {
    const list = L.claude;
    return vhead("Resume a Claude session", esc(place().name)) + `<div class="out">${!list ? '<div class="mute">Loading…</div>' : !list.length ? '<div class="empty"><span>No Claude sessions found for this folder.</span></div>' :
      `<div class="mute" style="font-size:12.5px">Picks it up as a new ${S.persp === "design" ? "design" : "code"} thread. One that is open in a terminal right now is copied (forked), so the two never interleave.</div><div class="blist">${list.map((x) => `<button data-resume="${esc(x.id)}|${x.live ? 1 : 0}"><span>${esc(x.title || "(no prompt)")}</span><span class="m">${esc(x.id.slice(0, 8))} · ${ago(x.mtime)}${x.live ? " · open in a terminal" : ""}</span></button>`).join("")}</div>`}</div>`;
  }
  function liveSignin() {
    return vhead("Sign in", "this browser") + `<div class="box"><div class="vform"><div class="mute">Paste the desk token (desk.toml action_token, or AGENT_DESK_TOKEN). It stays in this browser.</div>
      <input id="tokIn" class="inp mono" type="password" autocomplete="off" spellcheck="false" placeholder="token" /><div class="crow"><span class="sp"></span><button class="btn pri" data-act="signinGo">Sign in</button></div></div></div>`;
  }
  VIEWS.signin = () => liveSignin();
  const demoViews = { notes: renderNotes, usage: renderUsage, history: renderHistory, resume: renderResume };
  renderNotes = () => (L.on ? liveNotes() : demoViews.notes());
  renderUsage = () => (L.on ? liveUsage() : demoViews.usage());
  const demoCompute = { run: computeRun, refresh: computeRefresh };
  computeRun = (id, action, param) => (L.on ? wsSend({ type: "compute_run", id, action, param }) : demoCompute.run(id, action, param));
  computeRefresh = () => (L.on ? wsSend({ type: "compute_state" }) : demoCompute.refresh());
  // Compute chat: the machine's thread in the built-in "compute" source (made by the desk on the first message).
  const demoChat = { chat: computeChat, send: computeSend };
  computeChat = (m) => {
    if (!L.on) return demoChat.chat(m);
    return turns("compute", m.id).map((u) => {
      if (u.error && !u.text.includes(u.error)) u.text += (u.text ? "\n\n" : "") + `⚠ ${u.state === "cancelled" ? "Stopped" : "Error"}: ${u.error}`;
      const steps = u.steps.length ? `<details class="fold"><summary>${u.steps.length} steps${u.steps.some((s) => s.ok === false) ? " · some failed" : ""}</summary><div class="fb">${u.steps.slice(-40).map((s) => `<div class="step mono">${esc(stepLabel(s))}</div>`).join("")}</div></details>` : "";
      const asks = u.asks.filter((a) => !u.resolved.has(a.id)).map((a) => `<div class="ask"><div>Wants to use <code>${esc(a.tool)}</code>: <code>${esc(JSON.stringify(a.input).slice(0, 300))}</code></div><div class="acts"><button class="btn pri sm" data-approve="${esc(a.id)}|1">Allow</button><button class="btn sm" data-approve="${esc(a.id)}|0">Deny</button></div></div>`).join("");
      const reply = u.text || u.steps.length || u.asks.length || u.state === "working" ? `<div class="turn"><div class="who"><span class="dot s-${u.state === "working" ? "working" : u.state === "done" ? "done" : "idle"}"></span><b>Claude</b><span class="meta">· ${u.state === "working" && !u.text ? "working…" : ago(u.ts)}</span></div><div class="body">${u.text ? `<div>${md(u.text)}</div>` : ""}${steps}${asks}</div></div>` : "";
      const me = u.me != null ? `<div class="turn me"><div class="who">you</div><div class="body">${md(u.me)}</div></div>` : "";
      return reply + me;
    }).join("");
  };
  computeSend = () => {
    if (!L.on) return demoChat.send();
    const v = (COMPUTE.draft[COMPUTE.sel] ?? "").trim();
    if (!v) return toast("Type a message");
    wsSend({ type: "prompt", sourceId: "compute", threadId: COMPUTE.sel, text: v });
    COMPUTE.draft[COMPUTE.sel] = "";
    renderMid();
  };
  setInterval(() => { if (L.on && S.compute && S.persp === "compute" && !document.hidden) wsSend({ type: "compute_state" }); }, 30_000);
  renderHistory = () => (L.on ? liveHistory() : demoViews.history());
  renderResume = () => (L.on ? liveResume() : demoViews.resume());

  // Composer: the real "Run on" picker in General, attachment chips; typed text survives re-renders.
  composer = ((d) => (t) => {
    let h = d(t);
    if (!L.on) return h;
    if (place().kind === "general") h = h.replace(/<span class="chip">Run on <select data-sel="target">[\s\S]*?<\/select><\/span>/, '<span id="runOnSlot"></span>');
    if (L.atts.length) h = h.replace('<div class="crow">', `<div class="attchips">${L.atts.map((a, i) => `<span class="chip">${a.failed ? "⚠ " : a.path ? "" : "… "}${esc(a.name)}<button data-unatt="${i}" title="Remove">×</button></span>`).join("")}</div><div class="crow">`);
    return h;
  })(composer);
  renderMid = ((d) => () => {
    const ta = $("msg"), keep = ta && { v: ta.value, a: ta.selectionStart, b: ta.selectionEnd, f: document.activeElement === ta };
    d();
    if (!L.on) return;
    const nt = $("msg");
    if (nt && keep && keep.v && !nt.value) { nt.value = keep.v; if (keep.f) { nt.focus(); nt.setSelectionRange(keep.a, keep.b); } }
    X()?.mountRunOn(document.getElementById("runOnSlot"));
    if (S.view === "history") drawHits();
    if (S.view === "attach") drawBrowse();
  })(renderMid);

  // Attachments: 📎, paste or drop on the composer; uploaded at once, sent with the next message.
  document.body.insertAdjacentHTML("beforeend", '<input type="file" id="attFile" multiple hidden accept="image/*,application/pdf,text/*,.md,.json,.csv,.log,.zip">');
  async function upload(files) {
    for (const f of files) {
      if (L.atts.length >= 5) { toast("At most 5 files"); break; }
      if (f.size > 20 * 1024 * 1024) { toast(`${f.name}: over 20 MB`); continue; }
      const a = { name: f.name || "pasted-image.png", source: S.place };
      L.atts.push(a); renderMid();
      try {
        const r = await fetch(`/upload?source=${encodeURIComponent(a.source)}`, { method: "POST", headers: { "x-desk-token": tok() ?? "", "x-desk-name": encodeURIComponent(a.name), "content-type": f.type || "application/octet-stream" }, body: f });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error ?? `upload failed (${r.status})`);
        a.path = j.path;
      } catch (e) { a.failed = true; toast(`${a.name}: ${e.message}`); }
      renderMid();
    }
  }
  $("attFile").addEventListener("change", (e) => { if (L.on) upload([...e.target.files]); e.target.value = ""; });
  document.addEventListener("paste", (e) => { if (!L.on || e.target.id !== "msg") return; const fs = [...(e.clipboardData?.files ?? [])]; if (fs.length) { e.preventDefault(); upload(fs); } });
  document.addEventListener("dragover", (e) => { if (L.on && e.target.closest?.("#mid") && e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  document.addEventListener("drop", (e) => { if (!L.on || !e.target.closest?.("#mid")) return; const fs = [...(e.dataTransfer?.files ?? [])]; if (fs.length) { e.preventDefault(); upload(fs); } });
  // Typing in the views: history search, folder autocomplete.
  document.addEventListener("input", (e) => {
    if (!L.on) return;
    if (e.target.id === "histQ") { S.q = e.target.value; clearTimeout(L.ht); L.ht = setTimeout(() => { L.hits = null; drawHits(); }, 200); }
    if (e.target.id === "attLoc") { clearTimeout(L.lt); L.lt = setTimeout(() => {
      if (S.akind === "url") $("attLocs").innerHTML = [...new Set([...urls(), ...L.sources.filter((x) => x.kind === "url").map((x) => x.location)])].map((v) => `<option value="${esc(v)}">`).join("");
      else wsSend({ type: "ls", path: e.target.value });
    }, 150); }
  });
  document.addEventListener("keydown", (e) => {
    if (!L.on || e.key !== "Enter") return;
    if (e.target.id === "attLoc") { e.preventDefault(); liveAct("attachGo"); }
    if (e.target.id === "tokIn") { e.preventDefault(); liveAct("signinGo"); }
    if (e.target.id === "noteTa" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); liveAct("note"); }
  });

  const demoOut = out, demoAct = act, demoGo = go;
  out = (t) => (L.on ? liveOut(t) : demoOut(t));
  diffOf = ((d) => (f) => (L.on ? liveDiffOf(f) : d(f)))(diffOf);
  send = ((d) => () => (L.on ? liveSend() : d()))(send);
  act = (a, el) => (L.on ? liveAct(a, el) : demoAct(a, el));
  go = (p, t) => { const r = demoGo(p, t); if (L.on) refreshThread(); return r; };
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-approve], [data-lans], [data-base], [data-cmd], [data-urange], [data-bdir], [data-resume], [data-unatt]");
    if (!b || !L.on) return;
    if (b.dataset.urange) { L.usageRange = b.dataset.urange; return renderMid(); }
    if (b.dataset.bdir) return wsSend({ type: "ls", tag: "browse", path: b.dataset.bdir, limit: 500 });
    if (b.dataset.unatt) { L.atts.splice(+b.dataset.unatt, 1); return renderMid(); }
    if (b.dataset.resume) {
      const [id, live] = b.dataset.resume.split("|");
      if (live === "1" && !b.dataset.armed) { b.dataset.armed = "1"; b.querySelector(".m").textContent = "open in a terminal: tap again to start a forked copy here"; return; }
      S.view = "thread";
      wsSend({ type: "thread", sourceId: S.place, mode: S.persp === "design" ? "design" : "code", resume: id, fork: live === "1" });
      return render();
    }
    if (b.dataset.lans) { const [threadId, id, key] = b.dataset.lans.split("|"); return wsSend({ type: "live_answer", sourceId: S.place, threadId, id, key }); }
    if (b.dataset.approve) { const [id, ok] = b.dataset.approve.split("|"); wsSend({ type: "approve", id, allow: ok === "1" }); }
    else if (b.dataset.base) setTimeout(refreshThread, 0);
    else if (b.dataset.cmd && b.dataset.cmd !== "/<command>" && thr()) { e.stopImmediatePropagation(); closeMenu(); wsSend({ type: "prompt", sourceId: S.place, threadId: thr().id, text: b.dataset.cmd }); }
  }, true);
  // Links into a thread (alerts, old bookmarks): #source=<id>&thread=<id>. Opened once, then dropped from the URL.
  function openHash(h) {
    const q = new URLSearchParams(String(h).slice(1)), src = q.get("source"), th = q.get("thread");
    if (!src || !th || !L.sources.some((x) => x.id === src && x.threads[th])) return;
    q.delete("source"); q.delete("thread");
    history.replaceState(null, "", location.pathname + location.search + (q.toString() ? "#" + q : ""));
    S.view = "thread";
    go(src, th);
  }
  addEventListener("hashchange", () => { if (L.on) openHash(location.hash); });
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", connect); else connect();
})();
