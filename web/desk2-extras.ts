// desk2: the shared UI modules (terminal, alerts, Ask targets, schedules, herdr sessions, health), bundled by vite.
//   terminal (xterm over /pty), alerts (web push), Ask targets (Run on), schedules, herdr
//   sessions and health dialogs, share-link prefill and attachment links.
// desk2-live.js drives them through window.deskExtras once it is connected.
import { initTerminal, openTerminal, toggleTerminal } from "./terminal";
import { initPush, onPushKey, togglePush } from "./push";
import { initSchedules, renderSchedules, showSchedules } from "./schedule";
import { attachByName, initHSessions, onHSessionError, onTrustNeeded, pinFor, renderHSessions, showHSessions } from "./hsessions";
import { initTargets, isBrowserTarget, onTargetGo, onTargetModels, setTargets, targetChoice } from "./targets";
import { splitAttached, takePrefill } from "./attach";
import "./health"; // binds #healthBtn and the #health dialog

let send: (m: unknown) => void = () => {};
let canAct = () => false;
const runOn = document.createElement("div"); // holder for the targets bar between renders
const pushBtn = document.querySelector<HTMLButtonElement>("#pushBtn")!;

initTerminal();
initTargets((m) => send(m), runOn);
const runOnBar = runOn.querySelector("#runOn")!; // kept: renders replace the composer around it
initSchedules((m) => send(m), () => canAct());
initHSessions((m) => send(m), () => canAct());
void initPush(pushBtn, (m) => send(m), (hash) => { location.hash = hash; });

const extras = {
  /** Called by desk2-live.js on welcome. */
  connect(sendFn: (m: unknown) => void, canActFn: () => boolean, welcome: any) {
    send = sendFn;
    canAct = canActFn;
    setTargets(welcome.targets ?? [], !!welcome.guestAsk && welcome.role !== "action");
  },
  /** Server messages these modules own. Returns true when handled. */
  onMsg(m: any, events: any[]): boolean {
    switch (m.type) {
      case "target_go": void onTargetGo(m, events); return true;
      case "target_models": onTargetModels(m); return true;
      case "push_key": void onPushKey(m.key); return true;
      case "schedules": renderSchedules(m.rows); return true;
      case "hsessions": renderHSessions(m.rows); return true;
      case "hsession_trust": onTrustNeeded(m.name, m.dir); return true;
      case "error": return onHSessionError(m.error);
    }
    return false;
  },
  openTerminal, toggleTerminal, togglePush, showSchedules, showHSessions, pinFor, targetChoice, isBrowserTarget, attachByName, takePrefill, splitAttached,
  health: () => document.querySelector<HTMLButtonElement>("#healthBtn")!.click(),
  pushLabel: () => pushBtn.textContent ?? "",
  /** Put the "Run on" bar into the General composer (it is re-rendered often; the bar is kept). */
  mountRunOn(slot: Element | null) {
    (slot ?? runOn).append(runOnBar);
  },
  hasTargets: () => !(runOnBar as HTMLElement).hidden,
};
(window as any).deskExtras = extras;
