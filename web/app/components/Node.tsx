"use client";

import s from "./tree.module.css";
import { CAP_LABEL, type AgentNode } from "../lib/model";

const MAX_CHIPS = 4;

export function Node({ node, depth, flash }: { node: AgentNode; depth: number; flash: boolean }) {
  const shown = node.capabilities.slice(0, MAX_CHIPS);
  const hidden = node.capabilities.length - shown.length;
  const pct = node.spendCap === 0 ? 0 : (node.spendRemaining / node.spendCap) * 100;
  const low = pct < 25;

  return (
    <button
      type="button"
      className={`${s.node} ${s[node.state]} ${flash ? s.flash : ""}`}
      aria-label={`${node.name}, ${node.state}, ${node.spendRemaining} of ${node.spendCap} USDC remaining`}
    >
      <span className={s.nameRow}>
        <span className={s.name}>{node.name}</span>
        <span className={s.depth}>d{depth}</span>
      </span>

      <span className={s.chips}>
        {shown.map((c) => (
          <span key={c} className={`${s.chip} ${c === "data.graph.read" ? s.chipRead : ""}`}>
            {CAP_LABEL[c] ?? c}
          </span>
        ))}
        {hidden > 0 && <span className={`${s.chip} ${s.chipMore}`}>+{hidden}</span>}
      </span>

      <span className={s.meter} role="presentation">
        <span className={`${s.fill} ${low ? s.fillLow : ""}`} style={{ width: `${pct}%` }} />
      </span>

      <span className={s.meta}>
        <span>{node.spendRemaining} / {node.spendCap} USDC</span>
        <span>{node.expiresIn}</span>
        {node.readOnly && <span className={s.ro}>read-only</span>}
      </span>
    </button>
  );
}
