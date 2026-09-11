"use client";

import s from "./tree.module.css";
import { Node } from "./Node";
import type { AgentNode } from "../lib/model";

function Subtree({ node, depth, flashId }: { node: AgentNode; depth: number; flashId: string | null }) {
  return (
    <div className={s.branch}>
      <Node node={node} depth={depth} flash={node.id === flashId} />
      {node.children.length > 0 && (
        <div className={s.rung}>
          {node.children.map((c) => (
            <div key={c.id} className={s.kid}>
              <Subtree node={c} depth={depth + 1} flashId={flashId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tree({ root, flashId }: { root: AgentNode | null; flashId: string | null }) {
  if (!root) {
    return (
      <p className={s.empty}>
        No tree for that name. Try <span className="mono">attenuate.eth</span>.
      </p>
    );
  }
  return (
    <div className={s.level}>
      <Subtree node={root} depth={0} flashId={flashId} />
    </div>
  );
}
