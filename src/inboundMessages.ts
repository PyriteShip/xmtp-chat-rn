/**
 * The inbound-message engine: one global stream per client, with the
 * bookkeeping every consumer of it needs.
 *
 * Self-sends are dropped (they never create unread state), each message id is
 * remembered so a stream redelivery cannot fire the same notification twice,
 * and activity listeners are nudged for EVERY inbound message — including ones
 * that carry no notification body, like a passive context card — so the unread
 * badge re-derives off this single stream instead of opening a second one.
 *
 * What a message means, and what it should say, belong to the consumer.
 */

import { createMMKV } from 'react-native-mmkv';
import type { Client, DecodedMessage } from '@xmtp/react-native-sdk';

const HANDLED_KEY = 'inbound.handledIds';
const HANDLED_MAX = 200;

export interface InboundMessage { client: Client<any>; message: DecodedMessage }

let storage: ReturnType<typeof createMMKV> | null = null;
function store(): ReturnType<typeof createMMKV> {
  if (!storage) storage = createMMKV({ id: 'xmtp' });
  return storage;
}

let handledIds: string[] | null = null;
function ids(): string[] {
  if (!handledIds) {
    try {
      const raw = store().getString(HANDLED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      handledIds = Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      handledIds = [];
    }
  }
  return handledIds;
}

export function wasInboundHandled(id: string): boolean {
  return ids().includes(id);
}

/** Bounded oldest-first, so a long-lived install cannot grow the ring forever. */
export function markInboundHandled(id: string): void {
  const list = ids();
  if (list.includes(id)) return;
  list.push(id);
  if (list.length > HANDLED_MAX) list.splice(0, list.length - HANDLED_MAX);
  try {
    store().set(HANDLED_KEY, JSON.stringify(list));
  } catch {
    // Dedup within the session still works without persistence.
  }
}

/** Test seam. */
export function __resetInboundHandled(): void {
  handledIds = [];
  try { store().remove(HANDLED_KEY); } catch { /* nothing persisted */ }
}

const activityListeners = new Set<() => void>();
export function subscribeXmtpMessageActivity(cb: () => void): () => void {
  activityListeners.add(cb);
  return () => { activityListeners.delete(cb); };
}

let currentClient: Client<any> | null = null;
let running = false;

export async function startInboundMessages(
  client: Client<any>,
  handler: (m: InboundMessage) => Promise<void> | void,
): Promise<void> {
  if (running && currentClient === client) return;
  stopInboundMessages();
  currentClient = client;
  running = true;

  // streamAllMessages resolves only when the stream closes, so it is
  // deliberately not awaited.
  client.conversations
    .streamAllMessages(async (message) => {
      if (!running || currentClient !== client) return;
      if (message.senderInboxId === client.inboxId) return;
      for (const cb of activityListeners) cb();
      if (wasInboundHandled(message.id)) return;
      try {
        await handler({ client, message });
      } catch (err: any) {
        console.warn('[xmtp] inbound handler threw', err?.message ?? err);
      }
    })
    .catch((err: any) => {
      console.warn('[xmtp] streamAllMessages failed', err?.message ?? err);
    });
}

export function stopInboundMessages(): void {
  if (currentClient) {
    try { currentClient.conversations.cancelStreamAllMessages(); } catch {}
  }
  currentClient = null;
  running = false;
}
