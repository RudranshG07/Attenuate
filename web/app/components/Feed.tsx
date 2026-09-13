"use client";

import s from "./tree.module.css";
import { txUrl, type FeedItem } from "../lib/model";

const KIND_CLASS: Record<string, string> = {
  blocked: s.kBlocked,
  executed: s.kExecuted,
  mandate: s.kMandate,
};

export function Feed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return <p className={s.empty}>Nothing on chain yet. Grant a capability to start.</p>;
  }
  return (
    <>
      {items.map((i) => (
        <a
          key={i.id}
          className={s.item}
          href={txUrl(i.txHash, i.txUrl)}
          target="_blank"
          rel="noreferrer"
        >
          <span className={s.itemTop}>
            <span className={`${s.kind} ${KIND_CLASS[i.kind] ?? ""}`}>{i.kind}</span>
            <span className={s.at}>{i.at}</span>
          </span>
          <span className={s.itemName}>{i.name}</span>
          <span className={s.itemDetail}>{i.detail}</span>
          {i.reason && <span className={s.reason}>refused · {i.reason}</span>}
          <span className={s.hash}>{i.txHash}</span>
        </a>
      ))}
    </>
  );
}
