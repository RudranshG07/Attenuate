"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import s from "../components/tree.module.css";
import { Tree } from "../components/Tree";
import { Feed } from "../components/Feed";
import type { AgentNode, FeedItem } from "../lib/model";

type Conn = "checking" | "live" | "down";

function find(node: AgentNode, name: string): AgentNode | null {
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
}

export default function TreePage() {
  const [root, setRoot] = useState<AgentNode | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [conn, setConn] = useState<Conn>("checking");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, f] = await Promise.all([
        fetch("/api/tree", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/feed", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!t.connected) {
        setConn("down");
        return;
      }
      setConn("live");
      setRoot(t.root);
      setFeed(f.items ?? []);
      setQuery((q) => q || t.root?.name || "");
    } catch {
      setConn("down");
    }
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, [refresh]);

  const view = useMemo(
    () => (root ? find(root, query.trim() || root.name) : null),
    [root, query],
  );

  async function act(action: "grant" | "escalate" | "revoke") {
    setBusy(action);
    setError(null);
    try {
      const r = await fetch("/api/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).then((x) => x.json());

      if (!r.ok) setError(r.error ?? "transaction failed");
      if (action === "escalate" && root) {
        setFlashId(root.id);
        setTimeout(() => setFlashId(null), 700);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const dead = root?.state === "dead";

  return (
    <main className={s.screen}>
      <header className={s.top}>
        <span className={s.wordmark}>Attenuate</span>
        <span className={s.tagline}>a child name can never hold more power than its parent</span>
        <span className={s.spacer} />
        <span className={s.status} data-state={conn}>
          {conn === "live" ? "chain connected" : conn === "down" ? "no chain" : "connecting"}
        </span>
        <label htmlFor="q" style={{ color: "var(--dim)", fontSize: 12.5 }}>Resolve</label>
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

      {error && (
        <div className={s.banner} role="alert">
          {error}
          <button onClick={() => setError(null)} className={s.bannerAction}>Dismiss</button>
        </div>
      )}

      <section className={s.stage} aria-label="Permission tree" aria-busy={conn === "checking"}>
        {conn === "checking" && <div className={s.skeleton} aria-hidden="true" />}
        {conn === "down" && (
          <p className={s.empty}>
            No chain reachable. Start one, deploy, and seed a tree:
            <br />
            <span className="mono">npm run chain</span>
            <br />
            <span className="mono">npm run deploy:local</span>
            <br />
            <span className="mono">npx tsx scripts/seed-demo.ts</span>
          </p>
        )}
        {conn === "live" && !root && (
          <p className={s.empty}>
            Contracts are deployed but no root mandate has been signed yet. Run{" "}
            <span className="mono">npm run deploy:local</span>.
          </p>
        )}
        {conn === "live" && root && <Tree root={view} flashId={flashId} />}
      </section>

      <aside className={s.rail} aria-label="On-chain activity">
        <h2 className={s.railHead}>On-chain activity</h2>
        <Feed items={feed} />
      </aside>

      <footer className={s.bottom}>
        <button onClick={() => act("grant")} disabled={!root || dead || busy !== null}>
          {busy === "grant" ? "Granting…" : "Grant capability"}
        </button>
        <button onClick={() => act("escalate")} disabled={!root || dead || busy !== null}>
          {busy === "escalate" ? "Attempting…" : "Attempt escalation"}
        </button>
        <button onClick={() => act("revoke")} disabled={!root || dead || busy !== null}>
          {busy === "revoke" ? "Revoking…" : "Revoke root"}
        </button>
        <span className={s.spacer} />
        {dead && <span className={s.deadNote}>Root revoked. Whole subtree dead.</span>}
      </footer>
    </main>
  );
}
