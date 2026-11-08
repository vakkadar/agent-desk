// Parse the permission prompt Claude Code draws in a terminal (from `herdr pane read`).
// Pure: screen text in, prompt out. Claude accepts the option number as a key press.
export interface PromptOption {
  key: string; // what to type: the option number
  label: string;
  allow: boolean; // "Yes ..." options
}

export interface PermissionPrompt {
  title: string; // e.g. "Bash command", "Edit file"
  detail: string; // the command / diff shown above the question
  question: string; // e.g. "Do you want to proceed?"
  options: PromptOption[];
}

const OPTION = /^\s*(?:[❯>›]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
const RULE = /^\s*[─╌━-]{4,}\s*$/;
const BOX_TOP = /^\s*[─━]{4,}\s*$/;
const FOOTER = /Esc to cancel|Enter to select/;

export function parsePermissionPrompt(screen: string): PermissionPrompt | null {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  let i = lines.length - 1;
  while (i >= 0 && !FOOTER.test(lines[i])) i--;
  if (i < 0) return null;
  // Walk up from the footer collecting numbered options (wrapped lines join the option above).
  const opts: { n: number; label: string }[] = [];
  let cont: string[] = [];
  for (i--; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) {
      if (opts.length) break;
      continue;
    }
    const m = OPTION.exec(l);
    if (m) {
      opts.unshift({ n: Number(m[1]), label: [m[2], ...cont].join(" ") });
      cont = [];
    } else if (opts.length && /^\s{3,}\S/.test(l) && !l.trim().endsWith("?")) cont.unshift(l.trim());
    else break;
  }
  if (!opts.length || opts.some((o, k) => o.n !== k + 1)) return null;
  while (i >= 0 && !lines[i].trim()) i--;
  const question = lines[i]?.trim();
  if (!question?.endsWith("?")) return null;
  // Above the question: detail, back to the box's top rule. ╌ rules only divide the box.
  const above: string[] = [];
  for (i--; i >= 0 && !BOX_TOP.test(lines[i]); i--) above.unshift(lines[i]);
  const body = above.filter((l) => !RULE.test(l) && !/^\s*Tip:/.test(l)).map((l) => l.replace(/^ /, ""));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const title = body.shift()?.trim() ?? "";
  return {
    title,
    detail: body.join("\n").trim(),
    question,
    options: opts.map((o) => ({ key: String(o.n), label: o.label, allow: /^yes\b/i.test(o.label) })),
  };
}

/** Same prompt again? Used to answer only the prompt the user saw. */
export function promptSig(p: PermissionPrompt): string {
  return JSON.stringify([p.title, p.detail, p.question, p.options.map((o) => o.label)]);
}
