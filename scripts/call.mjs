// Minimal MCP client: node scripts/call.mjs '<json array of [tool, args]>' — prints each result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const calls = JSON.parse(process.argv[2]);
const client = new Client({ name: "demo", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/index.js", import.meta.url).pathname] }));
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`### ${name}${r.isError ? " (ERROR)" : ""}\n${r.content.map((c) => c.text).join("\n")}`);
  if (r.isError) break;
}
await client.close();
