/**
 * What using Attenuate looks like from outside it.
 *
 * This is an agent that knows nothing about this project: it speaks MCP over stdio,
 * discovers the tools, and asks before it acts. No import of our contracts, no ABI, no
 * address. That is the point of shipping an MCP server rather than a library — any
 * agent in any framework can hold a name and stay inside it.
 *
 *   npm run chain && npm run deploy:local
 *   npx tsx examples/mcp-client.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const AGENT = process.env.AGENT_NAME ?? "exec.attenuate.eth";
// A leaf cannot have children at all, so the interesting refusals live under a name
// that may delegate.
const PARENT = process.env.PARENT_NAME ?? "risk.attenuate.eth";

async function main() {
  const client = new Client({ name: "some-other-agent", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp-server/index.ts"],
    env: { ...process.env, ATTENUATE_DEPLOYMENT: process.env.ATTENUATE_DEPLOYMENT ?? "local" },
  }));

  const { tools } = await client.listTools();
  console.log("tools discovered over MCP:");
  for (const t of tools) {
    console.log(`  ${t.name.padEnd(20)} ${(t.description ?? "").split("\n")[0].slice(0, 62)}`);
  }

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
    console.log(`\n> ${name}(${JSON.stringify(args)})`);
    console.log(text);
    return text;
  };

  // 1. What am I allowed to do?
  await call("check_scope", { name: AGENT });

  // 2. Ask before spending gas on something the registry would refuse. The answer
  //    names the field to narrow, which is the difference between an error you can
  //    act on and one you have to read Solidity to understand.
  // Asking for more than the parent has left. The names here are the same strings
  // check_scope reported, so nothing had to know our bit positions.
  await call("simulate_grant", {
    parent: PARENT,
    grant: {
      capabilities: ["lend.aave.repay", "erc20.approve"],
      spendCap: "9999",
      queryBudget: "1",
      expiry: Math.floor(Date.now() / 1000) + 600,
      maxDepth: 0,
    },
  });

  // The same request, narrowed to what the answer said was available.
  await call("simulate_grant", {
    parent: PARENT,
    grant: {
      capabilities: ["lend.aave.repay", "erc20.approve"],
      spendCap: "10",
      queryBudget: "1",
      expiry: Math.floor(Date.now() / 1000) + 600,
      maxDepth: 0,
    },
  });

  await client.close();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
