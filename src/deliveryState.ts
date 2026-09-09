/**
 * Optimistic delivery state for the plain-text composer send.
 *
 * `useConversation.send` appends a local `pending` copy of the message the
 * moment the user taps Send, delivers it to XMTP in the background, and then
 * reconciles: on ack (`dm.send` resolves with the network message id) the local
 * copy adopts the real id and flips to `sent`; when the live stream echoes the
 * authoritative copy back it replaces the local one entirely (a message with no
 * `delivery` field is a confirmed network message). On throw the local copy
 * flips to `failed`, which the host's chat view renders with a "Not delivered ·
 * Tap to retry" affordance.
 *
 * Only plain-text composer sends are optimistic — custom-codec sends (action
 * cards, contact cards, diagnostics) go through their own send helpers and
 * reach the thread solely via the stream echo, which these helpers pass
 * through untouched.
 *
 * Pure functions over ChatMessage arrays (newest-first, like the hook's
 * state) so the reconciliation logic is unit-testable without the hook.
 */

import type { InboxId } from '@xmtp/react-native-sdk';

/**
 * `pending` → `sent` → `read` is the happy path; `failed` is the dead end.
 *
 * The first three are optimistic-send states owned by this module. `read` is
 * different in kind: it is set by a counterparty's read receipt long after the
 * network confirmed the message, so it can land on a message that carries no
 * `delivery` field at all (see `markReadUpTo`).
 */
export type MessageDelivery = 'pending' | 'sent' | 'failed' | 'read';

/**
 * The minimal shape these pure functions need: an id to target, a timestamp
 * to sort by, a discriminant to tell a text bubble from everything else, and
 * — present only on a text bubble — its body and delivery state. The host's
 * concrete chat message union (whatever `Cards` it configured) always
 * satisfies this structurally; these functions never need to know what a
 * card payload looks like, so they take it as a type parameter rather than
 * importing the concrete union from `useConversation.ts`.
 */
export interface DeliveryTrackedMessage {
  id: string;
  sentNs: number;
  kind: string;
  fromMe: boolean;
  delivery?: MessageDelivery;
  text?: string;
}

/** The exact shape of a local optimistic text bubble, as built by `makeLocalTextMessage`. */
export interface LocalTextMessage {
  id: string;
  senderInboxId: InboxId;
  sentNs: number;
  fromMe: true;
  kind: 'text';
  text: string;
  delivery: MessageDelivery;
  replyToId?: string;
}

let localSeq = 0;
/** Unique per-mount id for a not-yet-acked local message. */
export function nextLocalId(): string {
  return `local-${++localSeq}`;
}

/**
 * A local message the network hasn't confirmed (echoed back) yet.
 *
 * `read` is deliberately excluded: it is applied to messages the network has
 * already confirmed, and treating one as optimistic would let `mergeStreamed`
 * overwrite it with a fresh copy — silently dropping the read state.
 */
export function isOptimistic<M extends DeliveryTrackedMessage>(m: M): boolean {
  return m.kind === 'text' && m.delivery !== undefined && m.delivery !== 'read';
}

const byNewest = <M extends DeliveryTrackedMessage>(a: M, b: M) => b.sentNs - a.sentNs;

/**
 * The local `pending` copy appended the moment the user taps Send. `replyToId`
 * carries the quoted message through, so the optimistic bubble shows its quote
 * immediately and a retry re-sends it as a reply rather than as a bare message.
 */
export function makeLocalTextMessage(
  text: string,
  senderInboxId: InboxId | null,
  nowMs: number = Date.now(),
  replyToId?: string,
): LocalTextMessage {
  return {
    id: nextLocalId(),
    senderInboxId: (senderInboxId ?? '') as InboxId,
    sentNs: nowMs * 1e6,
    fromMe: true,
    kind: 'text',
    text,
    delivery: 'pending',
    ...(replyToId ? { replyToId } : {}),
  };
}

/** Flip a local message's delivery state (pending ⇄ failed, → sent). */
export function setDelivery<M extends DeliveryTrackedMessage>(
  prev: M[],
  id: string,
  delivery: MessageDelivery,
): M[] {
  return prev.map((m) => (m.id === id && m.kind === 'text' ? ({ ...m, delivery } as M) : m));
}

/** Drop a message (the ✕ on a failed bubble). */
export function discardMessage<M extends DeliveryTrackedMessage>(prev: M[], id: string): M[] {
  return prev.filter((m) => m.id !== id);
}

/**
 * Ack from `dm.send`: the local copy adopts the network message id and flips
 * to `sent`, so the stream echo (same id) dedupes/replaces instead of double
 * bubbling. If the echo already landed (stream beat the ack), the local copy
 * is simply dropped.
 */
export function reconcileSent<M extends DeliveryTrackedMessage>(
  prev: M[],
  localId: string,
  sentId: string,
): M[] {
  if (prev.some((m) => m.id === sentId)) return discardMessage(prev, localId);
  return prev.map((m) =>
    m.id === localId && m.kind === 'text' ? ({ ...m, id: sentId, delivery: 'sent' as const } as M) : m,
  );
}

/**
 * Insert a streamed/decoded message newest-first. An id already present is a
 * duplicate — skipped, unless it's our optimistic copy, which the streamed
 * message (the authoritative version, with the network timestamp and no
 * `delivery` field) replaces. A same-text echo of an in-flight local text
 * (stream beat the ack, ids not linked yet) also replaces it, so a fast echo
 * never double-bubbles.
 */
export function mergeStreamed<M extends DeliveryTrackedMessage>(prev: M[], next: M): M[] {
  const byId = prev.findIndex((m) => m.id === next.id);
  if (byId >= 0) {
    if (!isOptimistic(prev[byId])) return prev;
    const copy = [...prev];
    copy[byId] = next;
    return copy.sort(byNewest);
  }
  if (next.kind === 'text' && next.fromMe) {
    const inFlight = prev.findIndex(
      (m) =>
        m.kind === 'text' &&
        (m.delivery === 'pending' || m.delivery === 'sent') &&
        m.text === next.text,
    );
    if (inFlight >= 0) {
      const copy = [...prev];
      copy[inFlight] = next;
      return copy.sort(byNewest);
    }
  }
  return [next, ...prev].sort(byNewest);
}

/**
 * Apply an incoming read receipt: every message of mine sent at or before
 * `upToNs` is now read. A receipt carries no message reference — its own
 * `sentNs` is the watermark — so this promotes the whole prefix rather than one
 * bubble.
 *
 * Only my own text bubbles are touched. Read state answers "did they see
 * mine?", so the counterparty's messages are irrelevant; and only messages the
 * network already has can have been read, which rules out `pending` (never
 * reached them) and `failed` (never will). Cards are left alone for the same
 * reason `setDelivery` skips them — `delivery` lives on the text branch of the
 * host's message union, so writing it onto a card would add a field its type
 * does not declare.
 *
 * Returns `prev` unchanged when nothing moves, so the hook's setState can skip
 * a re-render.
 */
export function markReadUpTo<M extends DeliveryTrackedMessage>(prev: M[], upToNs: number): M[] {
  let changed = false;
  const next = prev.map((m) => {
    const promotable = m.delivery === undefined || m.delivery === 'sent';
    if (m.kind !== 'text' || !m.fromMe || !promotable || m.sentNs > upToNs) return m;
    changed = true;
    return { ...m, delivery: 'read' as const } as M;
  });
  return changed ? next : prev;
}
