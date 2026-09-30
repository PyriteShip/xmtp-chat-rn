/**
 * The send side of a thread, shared by `useConversation` (DMs) and `useGroup`:
 * optimistic text and attachment sends with delivery state, tap-to-retry,
 * discard, and reaction toggling. What a send goes INTO is the caller's —
 * `prepare` resolves the conversation for a new send (a DM creates itself
 * there on first send; a group must already exist), and `current` is the one
 * already attached, which retry-by-republish and reactions act on.
 *
 * Read receipts are not here: whether a thread sends them is the caller's
 * policy (DMs may, groups do not).
 */

import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { InboxId, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import {
  AttachmentTooLargeError, AttachmentsNotConfiguredError, uploadAttachment,
  type LocalAttachmentFile,
} from './attachments';
import { applyReactionPlan, reactionPlan, type ReactionEvent } from './chatReactions';
import {
  makeLocalTextMessage,
  makeLocalAttachmentMessage,
  attachUploaded,
  reconcileSent,
  setDelivery,
  settleRetry,
  discardMessage,
  isLocalId,
} from './deliveryState';
import { sendTracked, republishStored } from './publishState';
import type { AnyChatMessage, ChatMessageBase } from './useConversation';

/** What a thread sends into — the slice of a `Dm`/`Group` this module calls. */
export interface SendTarget {
  send(content: any, opts?: any): Promise<string>;
  sendWithStatus?: (content: any, opts?: any) => Promise<{ id: string; status: 'published' | 'queued' }>;
  prepareMessage?: (content: any, opts?: any) => Promise<string>;
  publishPreparedMessages?: () => Promise<unknown>;
}

export interface ThreadSendDeps {
  prepare: () => Promise<SendTarget>;
  current: () => SendTarget | null;
  myInboxIdRef: MutableRefObject<InboxId | null>;
  setMessages: Dispatch<SetStateAction<AnyChatMessage[]>>;
  reactionsRef: MutableRefObject<ReadonlyMap<string, ReactionEvent[]>>;
  applyReactions: (next: ReadonlyMap<string, ReactionEvent[]>) => void;
}

export interface ThreadSend<M> {
  send: (text: string, replyToId?: string) => Promise<void>;
  sendAttachment: (file: LocalAttachmentFile) => Promise<void>;
  retryMessage: (message: M) => Promise<void>;
  discardFailed: (id: string) => void;
  toggleReaction: (targetId: string, emoji: string) => Promise<void>;
}

/**
 * The SDK's own id for a message it stored before the send failed, when the
 * error reports one as a string `messageId`. Duck-typed: no dependency on any
 * SDK's error class, so an SDK whose errors carry no id simply yields none.
 */
function storedMessageId(err: unknown): string | undefined {
  const id = (err as { messageId?: unknown } | null)?.messageId;
  return typeof id === 'string' ? id : undefined;
}

export function useThreadSend<M extends ChatMessageBase & { kind: string }>({
  prepare,
  current,
  myInboxIdRef,
  setMessages,
  reactionsRef,
  applyReactions,
}: ThreadSendDeps): ThreadSend<M> {
  // Ids of failed sends whose error reported the SDK's stored message id: the
  // SDK still holds these for publishing, so a retry republishes them. A
  // `failed` history message also has a stored id, but the SDK gave up on it,
  // so it is not listed here and a retry sends it again.
  const storedIdsRef = useRef<Set<string>>(new Set());

  /**
   * Deliver an already-appended local text message (as a quoted reply when
   * replyToId is given). Any throw flips the local bubble to failed
   * (retryable) instead of propagating — the bubble is the failure surface.
   */
  const deliverText = useCallback(
    async (localId: string, text: string, replyToId?: string) => {
      try {
        const dm = await prepare();
        // A reply rides XMTP's native reply type, which nests the text under
        // the id it answers; a plain send is just the string.
        const content = replyToId ? ({ reply: { reference: replyToId, content: { text } } } as any) : text;
        const sent = await sendTracked(dm, content);
        setMessages((prev) => reconcileSent(prev, localId, sent.id, sent.delivery));
      } catch (err: any) {
        console.warn('[xmtp] send failed', err?.message ?? err);
        // A publish error may carry the SDK's own id for the message it stored
        // before failing (duck-typed — no dependency on any particular SDK's
        // error class). Keying the failed copy by that id lets a later echo
        // reconcile by id instead of the same-text fallback in mergeStreamed.
        const messageId = storedMessageId(err);
        if (messageId) storedIdsRef.current.add(messageId);
        setMessages((prev) => setDelivery(prev, localId, 'failed', messageId));
      }
    },
    [prepare],
  );

  /**
   * Upload (unless a previous attempt already did), then send. The upload runs
   * before the conversation is prepared, so a file that can't be stored
   * never materializes an empty DM. An oversized file (`AttachmentTooLargeError`)
   * and an unconfigured host (`AttachmentsNotConfiguredError`, no
   * `attachments` passed to `configureXmtpChat`) both remove the bubble and
   * rethrow rather than leaving it `failed`: unlike a network failure,
   * retrying neither can fix it.
   */
  const deliverAttachment = useCallback(
    async (localId: string, file: LocalAttachmentFile | undefined, uploaded?: RemoteAttachmentContent) => {
      try {
        let content = uploaded;
        if (!content) {
          if (!file) throw new Error('Attachment has neither a local file nor uploaded content');
          content = await uploadAttachment(file);
          const done = content;
          setMessages((prev) => attachUploaded(prev, localId, done));
        }
        const dm = await prepare();
        const sent = await sendTracked(dm, { remoteAttachment: content } as any);
        setMessages((prev) => reconcileSent(prev, localId, sent.id, sent.delivery));
      } catch (err: any) {
        // Neither is retryable: an oversized file stays oversized, and an
        // unconfigured host stays unconfigured. Leaving a `failed` bubble for
        // either would offer tap-to-retry on something retrying can never fix.
        if (err instanceof AttachmentTooLargeError || err instanceof AttachmentsNotConfiguredError) {
          setMessages((prev) => discardMessage(prev, localId));
          throw err;
        }
        console.warn('[xmtp] attachment send failed', err?.message ?? err);
        // See deliverText's catch: key the failed copy by the error's own
        // messageId, when it carries one, so the echo reconciles by id.
        const messageId = storedMessageId(err);
        if (messageId) storedIdsRef.current.add(messageId);
        setMessages((prev) => setDelivery(prev, localId, 'failed', messageId));
      }
    },
    [prepare],
  );

  const sendAttachment = useCallback(
    async (file: LocalAttachmentFile) => {
      const local = makeLocalAttachmentMessage(file, myInboxIdRef.current);
      setMessages((prev) => [local, ...prev]);
      await deliverAttachment(local.id, file);
    },
    [deliverAttachment],
  );

  const send = useCallback(
    async (text: string, replyToId?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Optimistic append before any await, so the bubble appears the moment
      // the user taps Send; the stream echo replaces it via mergeStreamed.
      const local = makeLocalTextMessage(trimmed, myInboxIdRef.current, undefined, replyToId);
      setMessages((prev) => [local, ...prev]);
      await deliverText(local.id, trimmed, replyToId);
    },
    [deliverText],
  );

  const retryMessage = useCallback(
    async (message: M) => {
      // Only a text or attachment bubble carries `delivery` — the caller's `M`
      // only guarantees the minimal bound, so narrow through the internal wide
      // shape rather than widening the public bound.
      const target = message as unknown as AnyChatMessage;
      if (target.kind !== 'text' && target.kind !== 'attachment') return;
      const { delivery } = target;
      // The SDK still holds this message under this id: republish it rather
      // than sending it again, so the id (and the echo's match by it) never
      // changes and no second copy can reach the peer.
      const held =
        !isLocalId(target.id) &&
        (delivery === 'unpublished' || (delivery === 'failed' && storedIdsRef.current.has(target.id)));
      if (held) {
        const dm = current() as { publishPreparedMessages?: () => Promise<unknown> } | null;
        if (dm && typeof dm.publishPreparedMessages === 'function') {
          storedIdsRef.current.add(target.id);
          setMessages((prev) => setDelivery(prev, target.id, 'pending'));
          const outcome = await republishStored(dm as { publishPreparedMessages: () => Promise<unknown> });
          setMessages((prev) => settleRetry(prev, target.id, outcome));
          return;
        }
      }
      if (delivery !== 'failed') return;
      if (target.kind === 'text') {
        setMessages((prev) => setDelivery(prev, target.id, 'pending'));
        await deliverText(target.id, target.text, target.replyToId);
        return;
      }
      if (target.kind === 'attachment' && (target.localFile || target.attachment)) {
        setMessages((prev) => setDelivery(prev, target.id, 'pending'));
        await deliverAttachment(target.id, target.localFile, target.attachment);
      }
    },
    [deliverText, deliverAttachment, current],
  );

  const discardFailed = useCallback((id: string) => {
    // Local only. No SDK call cancels a message the SDK has already stored:
    // `deleteMessage` sends a deletion message to the peer and leaves the
    // stored copy queued, so it would deliver the very message being
    // discarded. When the SDK stored this one (a non-local id), a later
    // publish in the conversation may still deliver it, and its echo then
    // brings the bubble back. Retry is the reliable action for such a bubble.
    setMessages((prev) => discardMessage(prev, id));
  }, []);

  const toggleReaction = useCallback(
    async (targetId: string, emoji: string) => {
      const dm = current();
      const mine = myInboxIdRef.current;
      // No thread yet, or no inbox id to attribute the reaction to — without
      // the latter the optimistic event would fold as an anonymous reactor.
      if (!dm || !mine) return;
      const before = reactionsRef.current;
      const prior = before.get(targetId) ?? [];
      const plan = reactionPlan(prior, mine, emoji);
      const ctx = { reference: targetId, senderInboxId: mine, baseNs: Date.now() * 1e6 };
      const withSteps = (applied: number) => {
        // Rebuild from the CURRENT map, not the pre-tap one, so a reaction that
        // streamed in on another message meanwhile survives.
        const next = new Map(reactionsRef.current);
        next.set(targetId, applyReactionPlan(prior, plan, applied, ctx));
        return next;
      };
      // Show the pill immediately; the stream echoes the same events back and
      // the fold is idempotent per (sender, emoji), so the echo is a no-op.
      applyReactions(withSteps(plan.length));
      let sent = 0;
      try {
        for (const step of plan) {
          await sendTracked(dm, {
            reactionV2: {
              reference: targetId,
              action: step.action,
              schema: 'unicode',
              content: step.emoji,
            },
          } as any);
          sent += 1;
        }
      } catch (err: any) {
        // Keep exactly the steps that landed. A replace whose removal was sent
        // but whose add failed must not roll back to the old emoji — the
        // network has already dropped it, and the pill would then disagree
        // with what the peer sees.
        console.warn('[xmtp] reaction send failed', err?.message ?? err);
        applyReactions(withSteps(sent));
      }
    },
    [applyReactions, current, myInboxIdRef, reactionsRef],
  );

  return { send, sendAttachment, retryMessage, discardFailed, toggleReaction };
}
