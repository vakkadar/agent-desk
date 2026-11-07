// Minimal stateless MCP server (streamable HTTP, JSON responses) exposing one tool,
// `approve`, used by `claude -p --permission-prompt-tool mcp__desk__approve`.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Approvals } from "../approvals.js";

export const TOOL_NAME = "mcp__desk__approve";

const TOOL = {
  name: "approve",
  description: "Ask the agent-desk user to approve a tool call",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

/** URL path: /mcp/<secret>/<sourceId>/<threadId>. Returns true if handled. */
export function handleMcp(req: IncomingMessage, res: ServerResponse, secret: string, approvals: Approvals): boolean {
  const parts = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
  if (parts[0] !== "mcp") return false;
  if (parts[1] !== secret || parts.length !== 4) {
    res.writeHead(404).end();
    return true;
  }
  const [sourceId, threadId] = [decodeURIComponent(parts[2]), decodeURIComponent(parts[3])];
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return true;
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = await rpc(msg, sourceId, threadId, approvals);
    if (out === null) res.writeHead(202).end();
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  return true;
}

/** Handle one JSON-RPC message; null for notifications. Exported for tests. */
export async function rpc(msg: any, sourceId: string, threadId: string, approvals: Approvals): Promise<unknown> {
  if (msg.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-desk", version: "0.1.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      const a = msg.params?.arguments ?? {};
      const d = await approvals.request(sourceId, threadId, String(a.tool_name ?? "?"), a.input ?? {});
      const verdict = d.allow
        ? { behavior: "allow", updatedInput: a.input ?? {} }
        : { behavior: "deny", message: d.by === "timeout" ? "approval timed out" : "denied by user" };
      return ok({ content: [{ type: "text", text: JSON.stringify(verdict) }] });
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
  }
}
