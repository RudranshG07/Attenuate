import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  Granted as GrantedEvent,
  QuerySpent as QuerySpentEvent,
  Reclaimed as ReclaimedEvent,
  RegistryAuthorized as RegistryAuthorizedEvent,
  Revoked as RevokedEvent,
  RootInitialised as RootInitialisedEvent,
  Spent as SpentEvent,
} from "../generated/GrantStore/GrantStore";
import {
  EscalationBlocked as EscalationBlockedEvent,
  Granted as NamedEvent,
} from "../generated/AttenuatedSubregistry/AttenuatedSubregistry";
import { Executed as ExecutedEvent } from "../generated/Executor/Executor";
import { Agent, BudgetFlow, Escalation, Execution, Stats } from "../generated/schema";
import { ChildRegistry } from "../generated/templates";

const STATS = "global";

function stats(): Stats {
  let s = Stats.load(STATS);
  if (s == null) {
    s = new Stats(STATS);
    s.agentsGranted = BigInt.zero();
    s.agentsRevoked = BigInt.zero();
    s.escalationsBlocked = BigInt.zero();
    s.executions = BigInt.zero();
    s.totalSpent = BigInt.zero();
    s.maxDepthSeen = 0;
  }
  return s!;
}

function eventId(e: ethereum.Event): string {
  return e.transaction.hash.toHex() + "-" + e.logIndex.toString();
}

function agent(id: BigInt): Agent {
  let a = Agent.load(id.toString());
  if (a == null) {
    a = new Agent(id.toString());
    a.capabilities = BigInt.zero();
    a.spendCap = BigInt.zero();
    a.spendRemaining = BigInt.zero();
    a.queryBudget = BigInt.zero();
    a.queryRemaining = BigInt.zero();
    a.expiry = BigInt.zero();
    a.maxDepth = 0;
    a.readOnly = false;
    a.depth = 0;
    a.epoch = BigInt.zero();
    a.revoked = false;
    a.reclaimed = false;
    a.isRoot = false;
    a.subregistry = null;
    a.createdAt = BigInt.zero();
  }
  return a!;
}

export function handleRootInitialised(e: RootInitialisedEvent): void {
  let a = agent(e.params.node);
  let g = e.params.grant;
  a.capabilities = g.capabilities;
  a.spendCap = g.spendCap;
  a.spendRemaining = g.spendRemaining;
  a.queryBudget = g.queryBudget;
  a.queryRemaining = g.queryRemaining;
  a.expiry = g.expiry;
  a.maxDepth = g.maxDepth;
  a.readOnly = g.readOnly;
  a.epoch = g.epoch;
  a.isRoot = true;
  a.depth = 0;
  a.createdAt = e.block.timestamp;
  a.save();
}

export function handleGranted(e: GrantedEvent): void {
  let parent = agent(e.params.parent);
  let child = agent(e.params.child);
  let g = e.params.grant;

  child.capabilities = g.capabilities;
  child.spendCap = g.spendCap;
  child.spendRemaining = g.spendRemaining;
  child.queryBudget = g.queryBudget;
  child.queryRemaining = g.queryRemaining;
  child.expiry = g.expiry;
  child.maxDepth = g.maxDepth;
  child.readOnly = g.readOnly;
  child.epoch = g.epoch;
  child.parent = parent.id;
  child.depth = parent.depth + 1;
  child.createdAt = e.block.timestamp;
  child.save();

  parent.spendRemaining = parent.spendRemaining.minus(g.spendCap);
  parent.queryRemaining = parent.queryRemaining.minus(g.queryBudget);
  parent.save();

  let f = new BudgetFlow(eventId(e));
  f.from = parent.id;
  f.to = child.id;
  f.amount = g.spendCap;
  f.queryAmount = g.queryBudget;
  f.kind = "ALLOCATE";
  f.timestamp = e.block.timestamp;
  f.txHash = e.transaction.hash;
  f.save();

  let s = stats();
  s.agentsGranted = s.agentsGranted.plus(BigInt.fromI32(1));
  if (child.depth > s.maxDepthSeen) s.maxDepthSeen = child.depth;
  s.save();
}

// The registry emits the human-readable label; GrantStore only knows token ids.
export function handleNamed(e: NamedEvent): void {
  let a = agent(e.params.tokenId);
  a.label = e.params.label;
  a.owner = e.params.owner;
  a.save();
}

export function handleRevoked(e: RevokedEvent): void {
  let a = agent(e.params.node);
  a.revoked = true;
  a.epoch = e.params.epoch;
  a.save();

  let s = stats();
  s.agentsRevoked = s.agentsRevoked.plus(BigInt.fromI32(1));
  s.save();
}

export function handleReclaimed(e: ReclaimedEvent): void {
  let dead = agent(e.params.node);
  dead.reclaimed = true;
  dead.spendRemaining = BigInt.zero();
  dead.queryRemaining = BigInt.zero();
  dead.save();

  let f = new BudgetFlow(eventId(e));
  f.from = dead.id;
  f.amount = e.params.spend;
  f.queryAmount = e.params.query;
  f.kind = "RECLAIM";
  f.timestamp = e.block.timestamp;
  f.txHash = e.transaction.hash;

  if (e.params.toAncestor.gt(BigInt.zero())) {
    let anc = agent(e.params.toAncestor);
    anc.spendRemaining = anc.spendRemaining.plus(e.params.spend);
    anc.queryRemaining = anc.queryRemaining.plus(e.params.query);
    anc.save();
    f.to = anc.id;
  }
  f.save();
}

export function handleSpent(e: SpentEvent): void {
  let a = agent(e.params.node);
  a.spendRemaining = a.spendRemaining.minus(e.params.amount);
  a.save();

  let s = stats();
  s.totalSpent = s.totalSpent.plus(e.params.amount);
  s.save();
}

export function handleQuerySpent(e: QuerySpentEvent): void {
  let a = agent(e.params.node);
  a.queryRemaining = a.queryRemaining.minus(e.params.units);
  a.save();
}

export function handleRegistryAuthorized(e: RegistryAuthorizedEvent): void {
  const a = agent(e.params.node);
  a.subregistry = e.params.registry;
  a.save();

  // The root registry is a static data source. Every registry below it is deployed at
  // grant time, so the store authorising one is the first block we can index it from.
  if (!a.isRoot) {
    ChildRegistry.create(e.params.registry);
  }
}

export function handleExecuted(e: ExecutedEvent): void {
  let x = new Execution(eventId(e));
  x.agent = e.params.node.toString();
  x.capBit = e.params.capBit;
  x.target = e.params.target;
  x.spend = e.params.spend;
  x.queryCost = e.params.queryCost;
  x.timestamp = e.block.timestamp;
  x.txHash = e.transaction.hash;
  x.save();

  let s = stats();
  s.executions = s.executions.plus(BigInt.fromI32(1));
  s.save();
}

// Refused grants never mint, so this is the only record they leave.
export function handleEscalationBlocked(e: EscalationBlockedEvent): void {
  let x = new Escalation(eventId(e));
  x.attemptedBy = e.params.attemptedBy;
  x.label = e.params.label;
  x.reason = e.params.reason;
  x.proposedCapabilities = e.params.proposed.capabilities;
  x.proposedSpendCap = e.params.proposed.spendCap;
  x.proposedExpiry = e.params.proposed.expiry;
  x.blockNumber = e.block.number;
  x.timestamp = e.block.timestamp;
  x.txHash = e.transaction.hash;
  x.save();

  let s = stats();
  s.escalationsBlocked = s.escalationsBlocked.plus(BigInt.fromI32(1));
  s.save();
}
