import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * One key per agent.
 *
 * The whole claim of this project is that a sub-agent holds a name and a key of its
 * own, not a function call with a name attached. That is only true if the keys are
 * actually distinct and the chain sees them: `Executor.execute` requires
 * `msg.sender == STORE.agentOf(node)`, so an agent that does not hold its own key
 * cannot spend, whatever its grant says.
 *
 * Keys are derived from the label so a demo is reproducible and anyone can re-run it
 * and land on the same addresses. These are testnet identities on purpose — the
 * secret that matters is the device key that signs the root mandate, and that one is
 * never in this repo.
 */
const SEED = process.env.ATTENUATE_AGENT_SEED ?? "attenuate/agent/v1";

export function agentKey(label: string): Hex {
  return keccak256(stringToHex(`${SEED}/${label}`));
}

export function agentAccount(label: string) {
  return privateKeyToAccount(agentKey(label));
}

export function agentAddress(label: string): Address {
  return agentAccount(label).address;
}
