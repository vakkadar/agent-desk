// Web Push alerts: turn finished / approval requested. VAPID keys and
// subscriptions live under <dataDir>/.index (mode 600).
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import webpush from "web-push";
import type { EventBus } from "./events/bus.js";
import type { DeskEvent } from "./types.js";

export interface Sub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface Payload { title: string; body: string; url: string; tag: string }

/** Notification for an event, or null when nothing should be sent. `answer` = text of the finished turn. */
export function buildPayload(e: DeskEvent, answer = ""): Payload | null {
  const ev = e.event;
  const title = `${e.sourceId}/${e.threadId}`;
  const url = `#source=${encodeURIComponent(e.sourceId)}&thread=${encodeURIComponent(e.threadId)}`;
  if (ev.kind === "approval_request") return { title, body: `Approval: ${ev.tool}`, url, tag: `approval-${ev.id}` };
  if (ev.kind !== "done" || ev.outcome === "cancelled") return null;
  const text = answer.replace(/\s+/g, " ").trim();
  const body = ev.outcome === "error" ? `Error: ${ev.error ?? "turn failed"}` : text || "Turn finished";
  return { title, body: body.slice(0, 100), url, tag: title };
}

export function validSub(s: any): s is Sub {
  return !!s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

/** Add (replacing the same endpoint) / remove, returning a new list. */
export const addSub = (subs: Sub[], s: Sub): Sub[] => [...subs.filter((x) => x.endpoint !== s.endpoint), { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }];
export const removeSub = (subs: Sub[], endpoint: string): Sub[] => subs.filter((x) => x.endpoint !== endpoint);

export async function loadSubs(file: string): Promise<Sub[]> {
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(j) ? j.filter(validSub) : [];
  } catch {
    return [];
  }
}

export async function saveSubs(file: string, subs: Sub[]): Promise<void> {
  await writeFile(file, JSON.stringify(subs, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
}

export class Push {
  private subs: Sub[] = [];
  private answers = new Map<string, string>(); // "source/thread" → text of the running turn
  private vapid!: { publicKey: string; privateKey: string };
  private vapidFile: string;
  private subsFile: string;

  constructor(dataDir: string, private subject = "mailto:agent-desk@localhost") {
    this.vapidFile = join(dataDir, ".index", "vapid.json");
    this.subsFile = join(dataDir, ".index", "push-subs.json");
  }

  async init(): Promise<void> {
    await mkdir(join(this.vapidFile, ".."), { recursive: true });
    try {
      this.vapid = JSON.parse(await readFile(this.vapidFile, "utf8"));
    } catch {
      this.vapid = webpush.generateVAPIDKeys();
      await writeFile(this.vapidFile, JSON.stringify(this.vapid), { mode: 0o600 });
      await chmod(this.vapidFile, 0o600);
    }
    this.subs = await loadSubs(this.subsFile);
  }

  get publicKey(): string { return this.vapid.publicKey; }

  async subscribe(s: unknown): Promise<void> {
    if (!validSub(s)) throw new Error("bad push subscription");
    this.subs = addSub(this.subs, s);
    await saveSubs(this.subsFile, this.subs);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    this.subs = removeSub(this.subs, endpoint);
    await saveSubs(this.subsFile, this.subs);
  }

  attach(bus: EventBus): void {
    bus.subscribe((e) => {
      const key = `${e.sourceId}/${e.threadId}`;
      if (e.event.kind === "prompt") this.answers.delete(key);
      else if (e.event.kind === "text") this.answers.set(key, (this.answers.get(key) ?? "") + e.event.text);
      const p = buildPayload(e, this.answers.get(key));
      if (e.event.kind === "done") this.answers.delete(key);
      if (p) void this.send(p);
    });
  }

  private async send(p: Payload): Promise<void> {
    if (!this.subs.length) return;
    const body = JSON.stringify(p);
    const dead = new Set<string>();
    await Promise.all(this.subs.map((s) =>
      webpush.sendNotification(s, body, { vapidDetails: { subject: this.subject, ...this.vapid }, TTL: 3600 }).catch((err) => {
        if (err?.statusCode === 404 || err?.statusCode === 410) dead.add(s.endpoint);
      }),
    ));
    if (dead.size) {
      this.subs = this.subs.filter((s) => !dead.has(s.endpoint));
      await saveSubs(this.subsFile, this.subs).catch(() => {});
    }
  }
}
