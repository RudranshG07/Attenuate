"use client";

import { useMemo, useState } from "react";
import s from "../components/tree.module.css";
import { Tree } from "../components/Tree";
import { Feed } from "../components/Feed";
import { demoFeed, demoTree } from "../lib/demo";
import type { AgentNode, FeedItem } from "../lib/model";

function find(node: AgentNode, name: string): AgentNode | null {
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

function markDead(node: AgentNode): AgentNode {
  return { ...node, state: "dead", children: node.children.map(markDead) };
}

let seq = 0;

export default function TreePage() {
  const [root, setRoot] = useState<AgentNode>(demoTree);
  const [feed, setFeed] = useState<FeedItem[]>(demoFeed);
  const [query, setQuery] = useState("attenuate.eth");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [reorg, setReorg] = useState(false);

  const view = useMemo(() => find(root, query.trim() || root.name), [root, query]);

  function push(item: Omit<FeedItem, "id" | "at">) {
    setFeed((f) => [{ ...item, id: `n${seq++}`, at: "now" }, ...f]);
  }

  function grant() {
    const label = `task${seq}`;
    const child: AgentNode = {
      id: `n${seq++}`,
      name: `${label}.exec.attenuate.eth`,
      capabilities: ["lend.aave.repay"],
      spendCap: 20,
      spendRemaining: 20,
      queryRemaining: 4,
      expiresIn: "10m",
      maxDepth: 0,
      readOnly: false,
      state: "live",
      children: [],
    };
    setRoot((r) => {
      const next = structuredClone(r);
      const exec = find(next, "exec.attenuate.eth");
      if (exec) {
        exec.children.push(child);
        exec.spendRemaining = Math.max(0, exec.spendRemaining - child.spendCap);
      }
      return next;
    });
    push({ kind: "granted", name: child.name, detail: "repay only, 20 USDC, expires 10m", txHash: randomHash() });
  }

  function escalate() {
    const target = find(root, "exec.attenuate.eth");
    if (!target) return;
    setFlashId(target.id);
    setTimeout(() => setFlashId(null), 600);
    push({
      kind: "blocked",
      name: target.name,
      detail: "planner proposed swap + approve, cap 900 USDC",
      reason: "SCOPE_WIDENED",
      txHash: randomHash(),
    });
  }

  function revoke() {
    setRoot((r) => markDead(r));
    push({ kind: "revoked", name: root.name, detail: "epoch bumped, whole subtree dead in one tx", txHash: randomHash() });
  }

  function reset() {
    setRoot(demoTree);
    setFeed(demoFeed);
    setQuery("attenuate.eth");
    setReorg(false);
  }

  const dead = root.state === "dead";

  return (
    <main className={s.screen}>
      <header className={s.top}>
        <span className={s.wordmark}>Attenuate</span>
        <span className={s.tagline}>a child name can never hold more power than its parent</span>
        <span className={s.spacer} />
        <label htmlFor="q" style={{ color: "var(--dim)", fontSize: 12.5 }}>
          Resolve
        </label>
        <input
          id="q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="attenuate.eth"
          spellCheck={false}
          autoComplete="off"
          style={{ width: 250 }}
        />
      </header>

      {reorg && (
        <div className={s.banner} role="status">
          Reorg detected at block 8,214,559. Tree state may be stale until the next
          irreversible block.
        </div>
      )}

      <section className={s.stage} aria-label="Permission tree">
        <Tree root={view} flashId={flashId} />
      </section>

      <aside className={s.rail} aria-label="Transaction feed">
        <h2 className={s.railHead}>On-chain activity</h2>
        <Feed items={feed} />
      </aside>

      <footer className={s.bottom}>
        <button onClick={grant} disabled={dead}>Grant capability</button>
        <button onClick={escalate} disabled={dead}>Attempt escalation</button>
        <button onClick={revoke} disabled={dead}>Revoke root</button>
        <span className={s.spacer} />
        <button onClick={() => setReorg((r) => !r)}>{reorg ? "Clear reorg" : "Simulate reorg"}</button>
        {dead && <button onClick={reset}>Reset demo</button>}
      </footer>
    </main>
  );
}

function randomHash() {
  const hex = "0123456789abcdef";
  let out = "0x";
  for (let i = 0; i < 12; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}
