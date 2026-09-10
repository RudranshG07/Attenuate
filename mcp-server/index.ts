import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const TOOLS = [
  "grant_capability",
  "revoke_agent",
  "check_scope",
  "query_position",
  "get_delegation_tree",
  "simulate_grant",
] as const;

const grantSchema = {
  capabilities: z.string(),
  spendCap: z.string(),
  queryBudget: z.string(),
  expiry: z.number().int(),
  maxDepth: z.number().int().nonnegative(),
  readOnly: z.boolean(),
};

const notImplemented = async () => {
  throw new Error("not implemented");
};

export function createServer(): McpServer {
  const server = new McpServer({ name: "attenuate", version: "0.1.0" });

  server.registerTool("simulate_grant", {
    description: "Dry-run a proposed grant.",
    inputSchema: { parent: z.string(), grant: z.object(grantSchema) },
  }, notImplemented);

  server.registerTool("check_scope", {
    description: "Check the live scope of a name.",
    inputSchema: { name: z.string() },
  }, notImplemented);

  server.registerTool("grant_capability", {
    description: "Mint a subname with an attenuated grant.",
    inputSchema: {
      parent: z.string(),
      label: z.string(),
      owner: z.string(),
      grant: z.object(grantSchema),
    },
  }, notImplemented);

  server.registerTool("revoke_agent", {
    description: "Revoke a name and its descendants.",
    inputSchema: { name: z.string() },
  }, notImplemented);

  server.registerTool("get_delegation_tree", {
    description: "Get the delegation tree under a root name.",
    inputSchema: { root: z.string() },
  }, notImplemented);

  server.registerTool("query_position", {
    description: "Query a lending position.",
    inputSchema: {
      name: z.string(),
      protocol: z.string(),
      account: z.string(),
    },
  }, notImplemented);

  return server;
}
