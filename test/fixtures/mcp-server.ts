import { createInterface } from "node:readline";

const readline = createInterface({ input: process.stdin });
for await (const line of readline) {
  const request = JSON.parse(line) as { readonly id?: number; readonly method: string; readonly params?: Record<string, unknown> };
  if (request.id === undefined) continue;
  if (request.method === "initialize") respond(request.id, { protocolVersion: "2024-11-05", serverInfo: { name: "test-server", version: "1" } });
  else if (request.method === "tools/list") respond(request.id, { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", additionalProperties: true } }] });
  else if (request.method === "tools/call") respond(request.id, { content: [{ type: "text", text: JSON.stringify(request.params) }] });
  else respond(request.id, { content: [], isError: true });
}
function respond(id: number, result: unknown): void { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
