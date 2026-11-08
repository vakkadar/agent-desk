// agent-desk-session: register and manage named herdr sessions on the desk host.
//   create <name> [dir] [--pin | --pin-stdin] [--no-start]
//   pin <name> [--clear | --pin-stdin]
//   list
//   close <name>      stop the herdr session (state -> closed)
//   rm <name>         forget it (the herdr session and folder are left alone)
// Opening (state -> open) happens from the desk: Sessions in the ⋯ menu, or "attach: <name>".
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { HerdrSessions, checkName, startSession, stopSession, runningSessions } from "./herdr-sessions.js";
import { loadEnvFile } from "./doctor.js";

function readHidden(label: string): string {
  // bash read -s: no echo, works over ssh -t.
  const r = spawnSync("bash", ["-c", `read -rs -p "${label}" p </dev/tty; echo >/dev/tty; printf %s "$p"`], { stdio: ["inherit", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error("could not read PIN (needs a terminal; use ssh -t, or --pin-stdin)");
  return r.stdout.toString();
}

function askPin(): string {
  const a = readHidden("PIN (4+ chars): ");
  if (a.length < 4) throw new Error("PIN too short");
  if (readHidden("again: ") !== a) throw new Error("PINs differ");
  return a;
}

const stdinPin = () => {
  const p = readFileSync(0, "utf8").trim();
  if (p.length < 4) throw new Error("PIN too short");
  return p;
};

async function main(argv: string[]): Promise<number> {
  loadEnvFile(`${homedir()}/.config/agent-desk/env`);
  const reg = new HerdrSessions(process.env.AGENT_DESK_DATA ?? `${homedir()}/agent-desk-data`);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [cmd, name, dirArg] = argv.filter((a) => !a.startsWith("--"));

  switch (cmd) {
    case "create": {
      if (!name) throw new Error("usage: create <name> [dir] [--pin | --pin-stdin] [--no-start]");
      checkName(name);
      const dir = resolve((dirArg ?? `~/projects/${name}`).replace(/^~(?=$|\/)/, homedir()));
      const pin = flags.has("--pin-stdin") ? stdinPin() : flags.has("--pin") ? askPin() : undefined;
      spawnSync("mkdir", ["-p", dir]);
      const s = reg.register({ name, dir, pin });
      console.log(`registered ${name} (${s.state}) in ${dir}${pin ? ", PIN set" : ""}`);
      if (!flags.has("--no-start")) process.stdout.write(await startSession(s));
      console.log(`\nNext: in the desk, ⋯ menu → Sessions → Open ${name}  (or type: attach: ${name})`);
      return 0;
    }
    case "pin": {
      if (!name) throw new Error("usage: pin <name> [--clear | --pin-stdin]");
      reg.setPin(name, flags.has("--clear") ? undefined : flags.has("--pin-stdin") ? stdinPin() : askPin());
      console.log(flags.has("--clear") ? `PIN cleared for ${name}` : `PIN set for ${name}`);
      return 0;
    }
    case "list": {
      const up = await runningSessions();
      const rows = reg.list();
      if (!rows.length) console.log("no sessions");
      for (const r of rows) console.log(`${r.name.padEnd(20)} ${r.state.padEnd(12)} ${up.has(r.name) ? "running" : "stopped"}  ${r.pinHash ? "PIN " : "    "} ${r.dir}`);
      return 0;
    }
    case "close": {
      if (!name) throw new Error("usage: close <name>");
      await stopSession(name);
      reg.setState(name, "closed");
      console.log(`${name} closed`);
      return 0;
    }
    case "rm": {
      if (!name) throw new Error("usage: rm <name>");
      reg.remove(name);
      console.log(`${name} removed from the desk (herdr session and folder left as they are)`);
      return 0;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 7).join("\n").replace(/^\/\/ ?/gm, ""));
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`error: ${e.message}`); process.exit(1); });
