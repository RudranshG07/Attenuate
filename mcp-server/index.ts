import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as h from "./handlers.js";

export const TOOLS = [
  "grant_capability",
  "revoke_agent",
  "check_scope",
  "query_position",
  "get_delegation_tree",
  "simulate_grant",
] as const;

// Capability names, the same strings check_scope reports, or a bitmask for callers
// that already have one. readOnly defaults to false so the common case is shorter.
const grantSchema = {
  capabilities: z.union([z.string(), z.array(z.string())]),
  spendCap: z.string(),
  queryBudget: z.string(),
  expiry: z.number().int(),
  maxDepth: z.number().int().nonnegative(),
  readOnly: z.boolean().optional(),
};

// Every tool returns JSON so an agent can act on the reason, not just read it.
function wrap<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(a), null, 2) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "attenuate", version: "0.1.0" });

  server.registerTool("simulate_grant", {
    description: "Dry-run a proposed grant against a parent name. Returns the exact reason it would be refused and which field to narrow, without spending gas. Call this before grant_capability.",
    inputSchema: { parent: z.string(), grant: z.object(grantSchema) },
  }, wrap(h.simulate_grant as any));

  server.registerTool("check_scope", {
    description: "What a name may actually do right now. Resolves the whole ancestor chain, so a name whose grandparent was revoked reports live:false.",
    inputSchema: { name: z.string() },
  }, wrap(h.check_scope as any));

  server.registerTool("grant_capability", {
    description: "Mint a subname with a grant that must be a strict subset of its parent. Simulates first and refuses without sending a transaction if it would fail.",
    inputSchema: {
      parent: z.string(),
      label: z.string(),
      owner: z.string(),
      grant: z.object(grantSchema),
    },
  }, wrap(h.grant_capability as any));

  server.registerTool("revoke_agent", {
    description: "Bump the epoch on a name. Kills it and every descendant in the same block, at constant gas.",
    inputSchema: { name: z.string() },
  }, wrap(h.revoke_agent as any));

  server.registerTool("get_delegation_tree", {
    description: "The full subtree under a name, with capabilities, remaining budget and liveness for every node.",
    inputSchema: { root: z.string() },
  }, wrap(h.get_delegation_tree as any));

  server.registerTool("query_position", {
    description: "Read live lending position data, paid per query from the budget attached to the name.",
    inputSchema: {
      name: z.string(),
      protocol: z.string(),
      account: z.string(),
    },
  }, wrap(h.query_position as any));

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
