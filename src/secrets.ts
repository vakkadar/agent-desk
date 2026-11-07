// Secret scan + redaction (FR-21).
export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=")|$)/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "password", re: /(\b(?:password|passwd|secret|api[_-]?key|token)["']?\s*[=:]\s*["']?)([^\s"',;\\]{6,})/gi },
];

export interface ScanResult { text: string; hits: string[] }

/** Redact secrets; returns new text and the distinct pattern names that matched. */
export function redact(text: string): ScanResult {
  const hits = new Set<string>();
  for (const { name, re } of SECRET_PATTERNS) {
    text = text.replace(re, (...a) => {
      const m = a[0] as string;
      if (name === "password") {
        if (a[2].startsWith("[REDACTED")) return m;
        hits.add(name);
        return `${a[1]}[REDACTED:${name}]`;
      }
      hits.add(name);
      return `[REDACTED:${name}]`;
    });
  }
  return { text, hits: [...hits] };
}
