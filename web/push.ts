// Alerts toggle: Web Push subscription via sw.js. Needs the home-screen app on iOS.
let send: (m: unknown) => void = () => {};
let btn: HTMLButtonElement;
let on = false;
let regError = ""; // why sw.js failed to register, shown when the toggle is tapped
let keyTimer: ReturnType<typeof setTimeout> | undefined;

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function show() {
  btn.textContent = !supported() ? "🔔 Alerts: n/a" : on ? "🔔 Alerts: on" : "🔔 Alerts: off";
}

function b64(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** onOpen(hash): a notification was tapped while the desk is open. */
export async function initPush(button: HTMLButtonElement, wsSend: (m: unknown) => void, onOpen: (hash: string) => void) {
  btn = button;
  send = wsSend;
  show();
  if (!supported()) return;
  navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "open" && onOpen(e.data.hash));
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");
    on = !!(await reg.pushManager.getSubscription()) && Notification.permission === "granted";
  } catch (e: any) {
    regError = String(e?.message ?? e);
  }
  show();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

export async function togglePush() {
  if (!supported()) return alert("Add to Home Screen to get alerts (iPhone: Share, then Add to Home Screen).");
  // iOS grants permission only when asked straight from the tap, so ask before any await.
  const perm = on ? null : Notification.requestPermission();
  btn.textContent = "🔔 Alerts: …";
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 10_000, `service worker${regError ? ` (${regError})` : ""}`);
    const sub = await reg.pushManager.getSubscription();
    if (on && sub) {
      send({ type: "push_unsubscribe", endpoint: sub.endpoint });
      await sub.unsubscribe();
      on = false;
      return show();
    }
    if ((await (perm ?? Notification.requestPermission())) !== "granted") {
      show();
      return alert("Notifications are blocked for this app.");
    }
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => { show(); alert("Alerts failed: no reply from the desk (read-only connection?)"); }, 10_000);
    send({ type: "push_key" }); // reply arrives in onPushKey
  } catch (e: any) {
    show();
    alert(`Alerts failed: ${e?.message ?? e}`);
  }
}

/** Server sent its VAPID public key: finish subscribing. */
export async function onPushKey(key: string) {
  clearTimeout(keyTimer);
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    send({ type: "push_subscribe", sub: sub.toJSON() });
    on = true;
  } catch (e: any) {
    alert(`Alerts failed: ${e?.message ?? e}`);
  }
  show();
}
