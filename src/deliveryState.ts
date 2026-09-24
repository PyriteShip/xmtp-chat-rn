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
 * Plain-text and attachment composer sends are optimistic — custom-codec sends
 * (action cards, contact cards, diagnostics) go through their own send helpers
 * and reach the thread solely via the stream echo, which these helpers pass
 * through untouched.
 *
 * Pure functions over ChatMessage arrays (newest-first, like the hook's
 * state) so the reconciliation logic is unit-testable without the hook.
 */

import type { InboxId, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import type { LocalAttachmentFile } from './attachments';

/**
 * `pending` → `sent` → `read` is the happy path; `failed` is the dead end.
 * `unpublished` sits between: the SDK stored the message and will publish it
 * itself later (it could not confirm it yet); the stream echo replaces it.
 *
 * The first four are optimistic-send states owned by this module. `read` is
 * set by a counterparty's read receipt (see `markReadUpTo`).
 */
export type MessageDelivery = 'pending' | 'sent' | 'unpublished' | 'failed' | 'read';

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
  /** Present on an attachment bubble once its upload has finished. */
  attachment?: { contentDigest: string };
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

/** A local optimistic attachment bubble. `attachment` appears once the upload finishes. */
export interface LocalAttachmentMessage {
  id: string;
  senderInboxId: InboxId;
  sentNs: number;
  fromMe: true;
  kind: 'attachment';
  /** The sender's own file, so the bubble renders before any upload. */
  localFile: LocalAttachmentFile;
  attachment?: RemoteAttachmentContent;
  delivery: MessageDelivery;
}

/** Text and attachment bubbles carry delivery state; cards never do. */
function tracksDelivery(m: DeliveryTrackedMessage): boolean {
  return m.kind === 'text' || m.kind === 'attachment';
}

const LOCAL_ID_PREFIX = 'local-';

let localSeq = 0;
/** Unique per-mount id for a not-yet-acked local message. */
export function nextLocalId(): string {
  return `${LOCAL_ID_PREFIX}${++localSeq}`;
}

/**
 * True for an id `nextLocalId` generated — one that never reached the SDK.
 * False once the message adopts a real id: an ack (`reconcileSent`), or a
 * failed send whose error carried the SDK's own stored-message id
 * (`setDelivery`'s rekey), or a message loaded from history. A host can use
 * `!isLocalId(message.id)` to decide whether a message can be the target of a
 * reply or a reaction: only a message with a network id can.
 */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/**
 * A local message the network hasn't confirmed (echoed back) yet.
 *
 * `read` is deliberately excluded: it is applied to messages the network has
 * already confirmed, and treating one as optimistic would let `mergeStreamed`
 * overwrite it with a fresh copy — silently dropping the read state.
 */
export function isOptimistic<M extends DeliveryTrackedMessage>(m: M): boolean {
  return tracksDelivery(m) && m.delivery !== undefined && m.delivery !== 'read';
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

export function makeLocalAttachmentMessage(
  file: LocalAttachmentFile,
  senderInboxId: InboxId | null,
  nowMs: number = Date.now(),
): LocalAttachmentMessage {
  return {
    id: nextLocalId(),
    senderInboxId: (senderInboxId ?? '') as InboxId,
    sentNs: nowMs * 1e6,
    fromMe: true,
    kind: 'attachment',
    localFile: file,
    delivery: 'pending',
  };
}

/**
 * Record a finished upload on the local copy. A retry after a failed send then
 * re-sends this content instead of uploading the file a second time, and the
 * stream echo can be matched to this bubble by digest.
 */
export function attachUploaded<M extends DeliveryTrackedMessage>(
  prev: M[],
  localId: string,
  content: RemoteAttachmentContent,
): M[] {
  return prev.map((m) =>
    m.id === localId && m.kind === 'attachment' ? ({ ...m, attachment: content } as M) : m,
  );
}

/**
 * Flip a local message's delivery state (pending ⇄ failed, → sent).
 *
 * `newId`, when given, also rekeys the message — a rejected send whose error
 * carries the SDK's own id for the message (it may have stored it before the
 * publish failed) is kept under that id, so a later stream echo with the same
 * id reconciles through `mergeStreamed`'s id match rather than its same-text
 * fallback. If a message with `newId` is already listed (its echo landed
 * first), the local copy is dropped instead, as `reconcileSent` does.
 */
export function setDelivery<M extends DeliveryTrackedMessage>(
  prev: M[],
  id: string,
  delivery: MessageDelivery,
  newId?: string,
): M[] {
  if (newId && newId !== id && prev.some((m) => m.id === newId)) return discardMessage(prev, id);
  return prev.map((m) =>
    m.id === id && tracksDelivery(m) ? ({ ...m, ...(newId ? { id: newId } : {}), delivery } as M) : m,
  );
}

/**
 * Record the outcome of a retry on a bubble that was set back to `pending`
 * for it, but only while it still is. The stream echo of the same id can land
 * while the retry is still running; it replaced the bubble with the
 * authoritative copy (no `delivery`), and stamping the retry's outcome onto
 * it would make a delivered message look optimistic again.
 */
export function settleRetry<M extends DeliveryTrackedMessage>(
  prev: M[],
  id: string,
  delivery: MessageDelivery,
): M[] {
  if (!prev.some((m) => m.id === id && m.delivery === 'pending')) return prev;
  return setDelivery(prev, id, delivery);
}

/** Drop a message (the ✕ on a failed bubble). */
export function discardMessage<M extends DeliveryTrackedMessage>(prev: M[], id: string): M[] {
  return prev.filter((m) => m.id !== id);
}

/**
 * Ack from the send: the local copy adopts the network message id and flips to
 * `sent`, or to `unpublished` when the SDK only stored it. The stream echo
 * (same id) then replaces it. If the echo already landed, the local copy is
 * dropped.
 */
export function reconcileSent<M extends DeliveryTrackedMessage>(
  prev: M[],
  localId: string,
  sentId: string,
  delivery: Extract<MessageDelivery, 'sent' | 'unpublished'> = 'sent',
): M[] {
  if (prev.some((m) => m.id === sentId)) return discardMessage(prev, localId);
  return prev.map((m) =>
    m.id === localId && tracksDelivery(m) ? ({ ...m, id: sentId, delivery } as M) : m,
  );
}

/** A local copy an echo may stand in for: still in flight, stored, or failed after the SDK may have stored it. */
function awaitingEcho(d: MessageDelivery | undefined): boolean {
  return d === 'pending' || d === 'sent' || d === 'unpublished' || d === 'failed';
}

/**
 * How far apart a `failed` text copy and a same-text echo of mine may be sent
 * for the echo to stand in for it. A failed copy can wait indefinitely, and
 * the same words sent again much later (from another device, say) are a
 * different message: absorbing the failed copy then would make an undelivered
 * message look delivered.
 */
const FAILED_ECHO_WINDOW_NS = 10 * 60 * 1e9;

/** Whether a same-text echo `next` may replace the local text copy `m`. */
function textEchoMatches<M extends DeliveryTrackedMessage>(m: M, next: M): boolean {
  if (m.kind !== 'text' || !awaitingEcho(m.delivery) || m.text !== next.text) return false;
  if (m.delivery !== 'failed') return true;
  return Math.abs(next.sentNs - m.sentNs) <= FAILED_ECHO_WINDOW_NS;
}

/**
 * Insert a streamed/decoded message newest-first. An id already present is a
 * duplicate — skipped, unless it's our optimistic copy, which the streamed
 * message (the authoritative version, with the network timestamp and no
 * `delivery` field) replaces. A same-text echo of an in-flight local text, or
 * a same-digest echo of an in-flight attachment (stream beat the ack, ids not
 * linked yet), also replaces it, so a fast echo never double-bubbles. A
 * `failed` copy counts too: a send can fail after the SDK stored the message,
 * and when that message publishes later its echo must not double the bubble.
 * A failed text copy matches by text only within `FAILED_ECHO_WINDOW_NS` of
 * the echo; a failed copy keyed by the SDK's stored id matches by id.
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
    const inFlight = prev.findIndex((m) => textEchoMatches(m, next));
    if (inFlight >= 0) {
      const copy = [...prev];
      copy[inFlight] = next;
      return copy.sort(byNewest);
    }
  }
  if (next.kind === 'attachment' && next.fromMe && next.attachment) {
    const digest = next.attachment.contentDigest;
    const inFlight = prev.findIndex(
      (m) =>
        m.kind === 'attachment' &&
        awaitingEcho(m.delivery) &&
        m.attachment?.contentDigest === digest,
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
 * Only my own text and attachment bubbles are touched. Read state answers
 * "did they see mine?", so the counterparty's messages are irrelevant; and
 * only messages the network already has can have been read, which rules out
 * `pending` (never reached them) and `failed` (never will). Cards are left
 * alone for the same reason `setDelivery` skips them — `delivery` lives on
 * the text and attachment branches of the host's message union, so writing
 * it onto a card would add a field its type does not declare.
 *
 * Returns `prev` unchanged when nothing moves, so the hook's setState can skip
 * a re-render.
 */
export function markReadUpTo<M extends DeliveryTrackedMessage>(prev: M[], upToNs: number): M[] {
  let changed = false;
  const next = prev.map((m) => {
    const promotable = m.delivery === undefined || m.delivery === 'sent';
    if (!tracksDelivery(m) || !m.fromMe || !promotable || m.sentNs > upToNs) return m;
    changed = true;
    return { ...m, delivery: 'read' as const } as M;
  });
  return changed ? next : prev;
}
