/**
 * Per-conversation last-read tracking for the Inbox unread indicator.
 *
 * XMTP V3 exposes no built-in unread/read API, so we track — locally — the
 * `sentNs` of the newest message the user has seen in each conversation. A
 * conversation reads as unread when its `lastMessage` is newer than this
 * watermark and was sent by the counterparty (not us). The watermark is
 * advanced from `useConversation` whenever the chat is open (history loaded or
 * a live message arrives while viewing).
 *
 * `createMMKV` is called lazily, as in dbKey, so Nitro is not instantiated
 * at import time (`createMMKV` memoizes per id); reuses the 'xmtp' namespace.
 *
 * Note: `sentNs` is nanoseconds and exceeds Number.MAX_SAFE_INTEGER, so it's a
 * lossy double — but both the stored watermark and the compared value come from
 * the same SDK number, so the comparison stays consistent.
 */

import { createMMKV } from 'react-native-mmkv';

const PREFIX = 'lastReadNs.';

let storage: ReturnType<typeof createMMKV> | null = null;
function store(): ReturnType<typeof createMMKV> {
  if (!storage) storage = createMMKV({ id: 'xmtp' });
  return storage;
}

// Listeners notified whenever a read watermark actually advances (a chat was
// opened/read). Lets the unread-count tab badge recompute reactively without
// polling. Fires only on a real change (markRead no-ops when not newer).
const readListeners = new Set<() => void>();
export function subscribeReadState(cb: () => void): () => void {
  readListeners.add(cb);
  return () => { readListeners.delete(cb); };
}
function notifyReadState(): void {
  for (const cb of readListeners) cb();
}

/** Newest `sentNs` the user has seen in this conversation (0 if never read). */
export function getLastReadNs(conversationId: string): number {
  return store().getNumber(PREFIX + conversationId) ?? 0;
}

/**
 * Advance the read watermark; no-ops if not newer than what's stored.
 *
 * Returns whether it actually advanced. Callers use that to fire side effects
 * exactly once per real change — sending a read receipt on every arriving
 * message would put a message on the wire for each one, including the receipts
 * the counterparty sends back.
 */
export function markRead(conversationId: string, sentNs: number): boolean {
  if (!conversationId || !sentNs) return false;
  const prev = store().getNumber(PREFIX + conversationId) ?? 0;
  if (sentNs > prev) {
    store().set(PREFIX + conversationId, sentNs);
    notifyReadState();
    return true;
  }
  return false;
}
