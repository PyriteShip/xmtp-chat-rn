/**
 * Unread-conversation count for the bottom-tab "Messages" badge.
 *
 * Returns the number of 1:1 conversations whose newest message is from the
 * counterparty and is newer than the local read watermark (the same `unread`
 * rule the host's inbox view renders per row, see useConversations). The count
 * is needed even when the inbox view isn't mounted, so this hook owns its own
 * light one-shot recompute rather than depending on `useConversations` state.
 *
 * Reactivity reuses the existing signals — no new polling loop:
 *  - `subscribeXmtpClient`        → client becomes ready / is dropped
 *  - `subscribeXmtpMessageActivity` → an inbound message off the single global
 *                                     stream owned by inboundMessages
 *  - `subscribeReadState`         → a chat was opened/read (watermark advanced)
 *
 * Gating mirrors the Inbox tab: 0 when XMTP is disabled or there's no usable
 * client (so the badge hides). The recompute is debounced and self-cancelling
 * across overlapping triggers.
 */

import { useEffect, useRef, useState } from 'react';
import { xmtpConfig } from './configure';
import { getActiveXmtpClient, subscribeXmtpClient } from './client';
import { getLastReadNs, subscribeReadState } from './readState';
import { describeMessage, isPreviewable } from './describeMessage';
import { subscribeXmtpMessageActivity } from './inboundMessages';
import type { ConsentState } from '@xmtp/react-native-sdk';

const CONSENT: ConsentState[] = ['allowed', 'unknown'];

/** Count conversations that currently read as unread for the active client. */
async function computeUnreadCount(): Promise<number> {
  const client = getActiveXmtpClient();
  if (!client) return 0;
  const myInboxId = client.inboxId;
  // Same query shape as useConversations: opts must set `lastMessage: true` or
  // the DMs carry no lastMessage to evaluate; order is irrelevant for a count.
  const dms = await client.conversations.listDms(
    { lastMessage: true }, undefined, CONSENT,
  );
  let count = 0;
  for (const dm of dms) {
    const last = dm.lastMessage;
    if (!last) continue;
    const description = describeMessage(last);
    const fromCounterparty = last.senderInboxId !== myInboxId;
    const unread =
      isPreviewable(description) && fromCounterparty && (last.sentNs ?? 0) > getLastReadNs(dm.id);
    if (unread) count += 1;
  }
  return count;
}

/**
 * Number of unread conversations (0 when XMTP is off / no client). Drives a
 * host's tab-badge style indicator; safe to call regardless of whether the
 * host's inbox view is mounted.
 */
export function useUnreadCount(): number {
  const [count, setCount] = useState(0);
  // Serialize overlapping recomputes: only the latest run's result is applied.
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!xmtpConfig().enabled) {
      setCount(0);
      return;
    }
    let active = true;

    const recompute = () => {
      const runId = ++runIdRef.current;
      computeUnreadCount()
        .then((n) => {
          if (active && runId === runIdRef.current) setCount(n);
        })
        .catch(() => {
          // Best-effort — a failed sync/list just leaves the prior count.
        });
    };

    recompute();
    const unsubs = [
      subscribeXmtpClient(recompute),
      subscribeXmtpMessageActivity(recompute),
      subscribeReadState(recompute),
    ];
    return () => {
      active = false;
      for (const u of unsubs) u();
    };
  }, []);

  return count;
}
