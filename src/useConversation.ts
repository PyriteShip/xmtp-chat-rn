/**
 * 1:1 DM hook for a single counterparty address.
 *
 * Resolves the active XMTP client, checks reachability (`canMessage`), attaches
 * to an EXISTING DM if there is one, loads history, and live-streams new
 * messages. Returns a flat, de-duplicated, newest-first array suitable for an
 * inverted FlatList.
 *
 * The DM is NOT created on mount — merely viewing a listing's "Message lender"
 * must not materialize an empty thread (which would otherwise pollute the
 * counterparty's Inbox). The DM is created lazily on the first `send()`.
 *
 * Conversations are address↔address, so the same thread can carry an ongoing
 * relationship across several distinct topics. To keep a long thread legible,
 * `send()` posts a `context` card (a `ContextCard` — a registered card type
 * plus a payload plus a caller-supplied identity key) when the caller passed
 * one whose key differs from the thread's most recent card of that same kind
 * (so a new thread, or a shift to a different context, gets a card;
 * re-messaging about the same one does not). What counts as "the same
 * context" is host-specific — one host may treat a sub-entity as more specific
 * than its parent — so the key is the caller's function, not this package's.
 *
 * Replies and reactions are XMTP messages that point at another message rather
 * than standing on their own, so they are handled apart from the bubble list. A
 * reply decodes into an ordinary `text` message carrying `replyToId`, which the
 * screen resolves against the thread it already holds. Reactions never become
 * bubbles at all: they accumulate in `reactions`, keyed by the message each one
 * targets, for the pill row under that bubble.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PublicIdentity,
  type Dm,
  type DecodedMessage,
  type InboxId,
} from '@xmtp/react-native-sdk';
import { getActiveXmtpClient, isXmtpClientInitializing, subscribeXmtpClient } from './client';
import { markRead } from './readState';
import { decodedMessageText } from './describeMessage';
import { decodeCard, findCardType, type CardMessage, type CardType } from './cardRegistry';
import { xmtpConfig } from './configure';
import { decodeReply, decodeReaction, isReaction, isReply } from './replyReaction';
import {
  applyReactionPlan,
  groupReactions,
  mergeReaction,
  reactionPlan,
  type ReactionEvent,
} from './chatReactions';
import {
  makeLocalTextMessage,
  mergeStreamed,
  reconcileSent,
  setDelivery,
  discardMessage,
  type MessageDelivery,
} from './deliveryState';

export interface ChatMessageBase {
  id: string;
  senderInboxId: InboxId;
  sentNs: number;
  fromMe: boolean;
}

/**
 * The chat message union this package renders: a plain text bubble, or a card
 * bubble for whichever content types `Cards` describes — the host's registry,
 * supplied to `configureXmtpChat`. `Extra` widens the union with message
 * kinds the host derives outside XMTP (e.g. a rental-lifecycle timeline
 * entry, merged into the thread by the host, not by this hook) — it defaults
 * to `never`, so a host with no such kinds writes `ChatMessage<typeof MY_CARDS>`.
 */
export type ChatMessage<
  Cards extends readonly CardType<any, any, any>[],
  Extra = never,
> =
  // `delivery` is only present on a local optimistic copy of a composer send
  // (see deliveryState.ts); a streamed/history message never carries it.
  // `replyToId` is set when the message is a quoted reply — it names the
  // message being answered, which the screen resolves against the loaded thread
  // (an id pointing outside the loaded window renders as an unavailable quote).
  | (ChatMessageBase & {
      kind: 'text';
      text: string;
      delivery?: MessageDelivery;
      replyToId?: string;
    })
  | CardMessage<Cards[number], ChatMessageBase>
  | Extra;

/**
 * The widest instantiation of `ChatMessage` — every card kind the configured
 * registry could produce, kind-erased to a plain `string` discriminant with
 * an `any`-valued payload. This hook builds and folds messages against this
 * shape internally, since the concrete `Cards` a host configured isn't known
 * until `xmtpConfig()` runs; the public `useConversation<M>` boundary casts
 * into the caller's concrete union, which the registry contract guarantees
 * this shape actually matches. Deliberately `CardType<string, any, string>`
 * rather than `CardType<any, any, any>` for the `kind` slot: TypeScript's
 * conditional-type distribution over an `any` type argument collapses the
 * whole card branch of `ChatMessage` to `never` once nested inside another
 * generic alias, which a plain (non-`any`) `string` doesn't trigger.
 */
type AnyChatMessage = ChatMessage<readonly CardType<string, any, string>[]>;

/**
 * Map a decoded message to a ChatMessage, or null if it isn't renderable. A
 * registered card type decodes to a `card` message; plain text becomes a
 * `text` message. XMTP V3 (MLS) system messages and empty text are dropped
 * (they'd otherwise render as blank bubbles), as are reactions — those belong
 * to the bubble they target, not to the thread (see `toReactionEvent`).
 */
function toChatMessage(m: DecodedMessage, myInboxId: InboxId | null): AnyChatMessage | null {
  const base: ChatMessageBase = {
    id: m.id,
    senderInboxId: m.senderInboxId,
    sentNs: m.sentNs,
    fromMe: !!myInboxId && m.senderInboxId === myInboxId,
  };
  if (isReaction(m)) return null;
  if (isReply(m)) {
    const reply = decodeReply(m);
    // A reply is an ordinary text bubble that additionally points at what it
    // answers. One whose payload isn't text (an attachment reply from another
    // client) keeps its codec fallback so the thread doesn't silently lose it.
    if (reply) return { ...base, kind: 'text', text: reply.text, replyToId: reply.reference };
    return m.fallback ? { ...base, kind: 'text', text: m.fallback } : null;
  }
  // Custom content types are matched through the configured card registry
  // (xmtpConfig().cards) rather than enumerated here, so this hook renders a
  // card kind it knows nothing about. A card whose payload won't decode or
  // fails its shape guard degrades to the codec's text `fallback` — the same
  // thing a client without the codec shows — rather than rendering a
  // half-empty bubble.
  const card = findCardType(xmtpConfig().cards, m);
  if (card) {
    const content = decodeCard(card, m);
    if (content !== null) {
      return { ...base, kind: card.kind, [card.payloadKey]: content } as AnyChatMessage;
    }
    return m.fallback ? { ...base, kind: 'text', text: m.fallback } : null;
  }
  const text = decodedMessageText(m);
  if (!text) return null;
  return { ...base, kind: 'text', text };
}

/**
 * A card the host wants posted at the top of a thread when the conversation's
 * subject changes — the `send()`-time counterpart of `xmtpConfig().cards`'s
 * registry entries. `cardType` names which registered card this is (its
 * codec's `contentType` is what actually goes on the wire); `key` is the
 * host's own notion of "same subject" — two payloads that share a key are the
 * same context — and this package has no opinion on how that is derived.
 */
export interface ContextCard<T = any> {
  cardType: CardType<any, T, any>;
  payload: T;
  key(payload: T): string;
}

/**
 * This message's context key, if it's a card of `ctx`'s own registered kind —
 * `AnyChatMessage`'s card branch has an erased, generic payload, so this is
 * the one place that needs the concrete payload shape back.
 */
function cardContextKey(m: AnyChatMessage, ctx: ContextCard): string | null {
  if (m.kind !== ctx.cardType.kind) return null;
  return ctx.key((m as any)[ctx.cardType.payloadKey]);
}

/**
 * Normalize a reaction message into the event the fold consumes. `reference`
 * falls back to `parentId` for a reaction fetched as a child of the message it
 * targets, where the parent is the reference by construction.
 */
function toReactionEvent(m: DecodedMessage, parentId?: string): ReactionEvent | null {
  const content = decodeReaction(m);
  if (!content) return null;
  const reference = content.reference || parentId;
  if (!reference) return null;
  return {
    reference,
    senderInboxId: m.senderInboxId,
    emoji: content.content,
    action: content.action as 'added' | 'removed',
    sentNs: m.sentNs,
  };
}

export interface UseConversationResult<M extends ChatMessageBase & { kind: string }> {
  messages: M[];
  /** null while the reachability check is in flight. */
  isReachable: boolean | null;
  /**
   * Whether OUR XMTP client is available. False means messaging is unavailable
   * for the connected wallet on this network (e.g. CDP smart wallet on a chain
   * XMTP can't verify SCW signatures for) — distinct from the counterparty
   * simply not having an inbox yet.
   */
  clientAvailable: boolean;
  isLoading: boolean;
  /**
   * The mount's init (reachability check / history load / stream attach)
   * threw — the thread could not be opened, as opposed to being empty.
   * `retryInit` re-runs it.
   */
  initError: boolean;
  retryInit: () => void;
  /**
   * Optimistic composer send: a local `pending` bubble appears immediately and
   * reconciles to the streamed copy on ack, or flips to `failed` on throw.
   * Never rejects — a delivery failure surfaces on the bubble, not as a throw.
   * `replyToId` sends it as a quoted reply to that message.
   */
  send: (text: string, replyToId?: string) => Promise<void>;
  /** Re-deliver a `failed` message (tap-to-retry on the bubble). */
  retryMessage: (message: M) => Promise<void>;
  /** Drop a `failed` message (the ✕ on the bubble). */
  discardFailed: (id: string) => void;
  /** Reaction events per target message id — fold with `summarizeReactions`. */
  reactions: ReadonlyMap<string, ReactionEvent[]>;
  /** Our own inbox id, so the fold can mark which pills are ours. */
  myInboxId: InboxId | null;
  /**
   * Apply `emoji` to a message under Signal's one-reaction-per-person rule:
   * tapping what you already hold clears it, tapping another replaces it. The
   * pill updates before the network round-trip and reverts if the send throws.
   */
  toggleReaction: (targetId: string, emoji: string) => Promise<void>;
}

/**
 * Generic over the caller's concrete message union `M` (e.g. the host's
 * `AppChatMessage`) rather than over `Cards`/`Extra` directly: the hook body
 * builds and folds messages against the internal `AnyChatMessage` shape
 * (the widest instantiation, since the concrete registry isn't known until
 * `xmtpConfig()` runs) and casts once at the public boundary — a host's `M`
 * is always a `ChatMessage<Cards, Extra>` for its own configured registry,
 * which the runtime registry lookup (`xmtpConfig().cards`) actually produces.
 */
export function useConversation<M extends ChatMessageBase & { kind: string }>(
  counterpartyAddress: string,
  context?: ContextCard,
): UseConversationResult<M> {
  const [messages, setMessages] = useState<AnyChatMessage[]>([]);
  const [reactions, setReactions] = useState<ReadonlyMap<string, ReactionEvent[]>>(new Map());
  const [myInboxId, setMyInboxId] = useState<InboxId | null>(null);
  const [isReachable, setIsReachable] = useState<boolean | null>(null);
  const [clientAvailable, setClientAvailable] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [initError, setInitError] = useState(false);
  // Bumped on every XMTP client lifecycle change (created after sign-in / reauth,
  // dropped, failed). Re-runs the init effect below so the chat self-heals when
  // the client comes up — without this, mounting before the client is ready
  // latches "unavailable" forever (the cold-start / degraded-reauth window).
  const [clientTick, setClientTick] = useState(0);
  useEffect(() => subscribeXmtpClient(() => setClientTick((t) => t + 1)), []);
  const dmRef = useRef<Dm<any> | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const myInboxIdRef = useRef<InboxId | null>(null);
  const cancelledRef = useRef(false);
  // Mirrors the `context` argument so attachDm's stream handler (identity-stable
  // across a context change, so it isn't torn down and reattached on one) always
  // reads the latest value rather than the one from whichever render created it.
  const contextRef = useRef(context);
  contextRef.current = context;
  // The context's key for the thread's most recent card of that kind — gates
  // whether send() posts a new card. Null until history is loaded / a card is
  // seen.
  const lastCardKeyRef = useRef<string | null>(null);
  // Mirrors `reactions` so toggleReaction can read the current fold without
  // taking the state as a dependency (which would re-create the callback, and
  // with it every bubble's press handler, on every incoming reaction).
  const reactionsRef = useRef<ReadonlyMap<string, ReactionEvent[]>>(new Map());
  const applyReactions = useCallback(
    (next: ReadonlyMap<string, ReactionEvent[]>) => {
      reactionsRef.current = next;
      setReactions(next);
    },
    [],
  );

  /**
   * Bind to a DM: load history, mark read, prime the last-card key, and start
   * the live stream. Shared by the mount effect (existing thread) and `send()`
   * (thread created on first send). The stream unsubscribe is stored in a ref
   * the cleanup always clears, and re-checked after the await so a fast unmount
   * can't leak a stream subscribed after teardown.
   */
  const attachDm = useCallback(async (dm: Dm<any>) => {
    dmRef.current = dm;
    await dm.sync();
    // Reactions ride along as `childMessages` of the message they target, which
    // only this variant populates. It needs native support the installed module
    // may predate, so a throw falls back to the plain history — the thread
    // loads without pills rather than not at all.
    let history: DecodedMessage[];
    try {
      history = await dm.messagesWithReactions();
    } catch (e: any) {
      console.warn('[xmtp] messagesWithReactions unavailable, loading without reactions', e?.message ?? e);
      history = await dm.messages();
    }
    if (cancelledRef.current) return;
    const mapped: AnyChatMessage[] = [];
    const events: ReactionEvent[] = [];
    for (const m of history) {
      for (const child of m.childMessages ?? []) {
        const event = toReactionEvent(child, m.id);
        if (event) events.push(event);
      }
      const chat = toChatMessage(m, myInboxIdRef.current);
      if (chat) mapped.push(chat);
    }
    mapped.sort((a, b) => b.sentNs - a.sentNs);
    setMessages(mapped);
    applyReactions(groupReactions(events));
    // Most recent card of the context's own kind (mapped is newest-first)
    // seeds the context-change gate. No-op when the caller passed no context —
    // nothing reads lastCardKeyRef in that case.
    const ctx = contextRef.current;
    lastCardKeyRef.current = ctx
      ? mapped.reduce<string | null>((found, m) => found ?? cardContextKey(m, ctx), null)
      : null;
    // Viewing the thread marks it read up to the newest message so the Inbox
    // unread dot clears. messages() order isn't guaranteed, so take the max.
    if (history.length > 0) {
      markRead(dm.id, history.reduce((max, m) => (m.sentNs > max ? m.sentNs : max), 0));
    }

    const unsub = await dm.streamMessages(async (m) => {
      if (cancelledRef.current) return;
      markRead(dm.id, m.sentNs); // arriving while the chat is open = read
      // A reaction arrives on the stream as a top-level message; it belongs to
      // the bubble it names, so it never joins the thread.
      const event = toReactionEvent(m);
      if (event) {
        applyReactions(mergeReaction(reactionsRef.current, event));
        return;
      }
      const cm = toChatMessage(m, myInboxIdRef.current);
      if (!cm) return; // skip system/non-text messages
      if (contextRef.current) {
        const key = cardContextKey(cm, contextRef.current);
        if (key !== null) lastCardKeyRef.current = key;
      }
      setMessages((prev) => mergeStreamed(prev, cm));
    });
    if (cancelledRef.current) {
      try { unsub(); } catch {}
      return;
    }
    unsubRef.current = unsub;
  }, [applyReactions]);

  useEffect(() => {
    cancelledRef.current = false;
    setMessages([]);
    applyReactions(new Map());
    setIsReachable(null);
    setClientAvailable(true);
    setIsLoading(true);
    setInitError(false);
    dmRef.current = null;
    lastCardKeyRef.current = null;

    (async () => {
      const client = getActiveXmtpClient();
      if (!client) {
        // Client still coming up (right after sign-in / reauth) — stay loading
        // and let the clientTick lifecycle subscription re-run this once it's
        // ready, rather than latching "unavailable".
        if (isXmtpClientInitializing()) {
          if (!cancelledRef.current) setIsLoading(true);
          return;
        }
        // Our own client isn't available (init failed or not yet connected) —
        // this is NOT a statement about the counterparty.
        if (!cancelledRef.current) {
          setClientAvailable(false);
          setIsLoading(false);
        }
        return;
      }
      myInboxIdRef.current = client.inboxId;
      setMyInboxId(client.inboxId);
      const identity = new PublicIdentity(counterpartyAddress.toLowerCase(), 'ETHEREUM');

      const canMap = await client.canMessage([identity]);
      const reachable = Object.values(canMap)[0] ?? false;
      if (cancelledRef.current) return;
      setIsReachable(reachable);
      if (!reachable) {
        setIsLoading(false);
        return;
      }

      // Attach only to an EXISTING thread; don't create one just for viewing.
      const existing = await client.conversations.findDmByIdentity(identity);
      if (cancelledRef.current) return;
      if (existing) await attachDm(existing);
      if (!cancelledRef.current) setIsLoading(false);
    })().catch((err) => {
      // Surface the failure — an init that dies must not render as an
      // empty-but-normal thread. The host's chat view shows an inline error + Retry.
      console.warn('[xmtp] useConversation init failed', err?.message ?? err);
      if (!cancelledRef.current) {
        setInitError(true);
        setIsLoading(false);
      }
    });

    return () => {
      cancelledRef.current = true;
      if (unsubRef.current) {
        try {
          unsubRef.current();
        } catch {}
        unsubRef.current = null;
      }
      dmRef.current = null;
    };
  }, [counterpartyAddress, attachDm, clientTick, applyReactions]);

  /**
   * Deliver an already-appended local message to XMTP: DM creation on first
   * send, the context card when this chat's context differs from the thread's
   * most recent card, then the text itself (as a quoted reply when `replyToId`
   * is given). Any throw along the way flips the local bubble to `failed`
   * (retryable) instead of propagating — the bubble is the failure surface.
   */
  const deliverText = useCallback(
    async (localId: string, text: string, replyToId?: string) => {
      try {
        let dm = dmRef.current;
        if (!dm) {
          // First send in a not-yet-created thread — create it now (the only place
          // a DM is materialized), then attach so the stream echoes our send back.
          const client = getActiveXmtpClient();
          if (!client) throw new Error('Messaging client unavailable');
          const identity = new PublicIdentity(counterpartyAddress.toLowerCase(), 'ETHEREUM');
          dm = await client.conversations.findOrCreateDmWithIdentity(identity);
          await attachDm(dm);
        }
        // Post a context card when this chat has caller context that differs
        // from the thread's most recent card of that kind — covers new threads
        // and shifts to a different subject. Sent before the text so it reads
        // as a header. The key is only advanced on success, so a retry re-sends
        // the card.
        if (context && context.key(context.payload) !== lastCardKeyRef.current) {
          await dm.send(context.payload as any, { contentType: context.cardType.codec.contentType });
          lastCardKeyRef.current = context.key(context.payload);
        }
        // A reply rides XMTP's native reply type, which nests the text under
        // the id it answers; a plain send is just the string.
        const sentId = replyToId
          ? await dm.send({ reply: { reference: replyToId, content: { text } } } as any)
          : await dm.send(text);
        setMessages((prev) => reconcileSent(prev, localId, sentId));
      } catch (err: any) {
        console.warn('[xmtp] send failed', err?.message ?? err);
        setMessages((prev) => setDelivery(prev, localId, 'failed'));
      }
    },
    [counterpartyAddress, attachDm, context],
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
      // Only a local optimistic text bubble carries `delivery`/`text` — the
      // caller's `M` only guarantees the minimal bound, so narrow through the
      // internal wide shape rather than widening the public bound to fields
      // only one variant has.
      const failed = message as unknown as AnyChatMessage;
      if (failed.kind !== 'text' || failed.delivery !== 'failed') return;
      setMessages((prev) => setDelivery(prev, failed.id, 'pending'));
      await deliverText(failed.id, failed.text, failed.replyToId);
    },
    [deliverText],
  );

  const discardFailed = useCallback((id: string) => {
    setMessages((prev) => discardMessage(prev, id));
  }, []);

  const toggleReaction = useCallback(
    async (targetId: string, emoji: string) => {
      const dm = dmRef.current;
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
          await dm.send({
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
    [applyReactions],
  );

  const retryInit = useCallback(() => setClientTick((t) => t + 1), []);

  return {
    // The registry contract guarantees the running messages are actually
    // shaped like the caller's M (a ChatMessage<Cards, Extra> for whichever
    // registry is configured); the package itself can't state that statically.
    messages: messages as unknown as M[],
    isReachable,
    clientAvailable,
    isLoading,
    initError,
    retryInit,
    send,
    retryMessage,
    discardFailed,
    reactions,
    myInboxId,
    toggleReaction,
  };
}
