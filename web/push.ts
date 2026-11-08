// Alerts toggle: Web Push subscription via sw.js. Needs the home-screen app on iOS.
let send: (m: unknown) => void = () => {};
let btn: HTMLButtonElement;
let on = false;

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
  } catch { /* leave off */ }
  show();
}

export async function togglePush() {
  if (!supported()) return alert("Add to Home Screen to get alerts (iPhone: Share, then Add to Home Screen).");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    send({ type: "push_unsubscribe", endpoint: sub.endpoint });
    await sub.unsubscribe();
    on = false;
    return show();
  }
  if ((await Notification.requestPermission()) !== "granted") return alert("Notifications are blocked for this app.");
  send({ type: "push_key" }); // reply arrives in onPushKey
}

/** Server sent its VAPID public key: finish subscribing. */
export async function onPushKey(key: string) {
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
