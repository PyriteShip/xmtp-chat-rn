/**
 * The shape a host's custom XMTP content types ("cards") conform to.
 *
 * Four places need to know which custom content types exist: the client (to
 * register their codecs), the chat hook (to turn a decoded message into a
 * renderable bubble), the inbox preview, and the notification stream. Each
 * card type declares itself once here as a `CardType` descriptor, and those
 * four sites iterate the registry instead of enumerating card types inline —
 * so adding a card type is one descriptor rather than four edits, and the
 * XMTP plumbing carries no knowledge of what any of them mean.
 *
 * The descriptors themselves live in the host and arrive via
 * `configureXmtpChat({ cards })`; this module is the contract plus the lookup
 * every consumer shares.
 */

import type { DecodedMessage, JSContentCodec } from '@xmtp/react-native-sdk';

/** Title/body for a local notification. An absent title means "use the default". */
export interface CardNotification {
  title?: string;
  body: string;
}

/**
 * One custom content type, described once for every consumer.
 *
 * `is` matches the wire type; `isValid` guards the decoded payload's shape,
 * because `decode` is unchecked JSON and a malformed or future-version card
 * must degrade to its text `fallback` rather than render a half-empty bubble.
 */
export interface CardType<K extends string = string, T = unknown, P extends string = string> {
  /** Discriminant on the rendered chat message. */
  kind: K;
  /** Property the decoded payload is rendered under (`kind: 'card'` → `card`). */
  payloadKey: P;
  /** Registered on every client so this type can be sent and received. */
  codec: JSContentCodec<T>;
  /** True when a decoded message carries this content type. */
  is(m: DecodedMessage): boolean;
  /** True when decoded content is a usable payload of this type. */
  isValid(content: unknown): content is T;
  /**
   * Inbox/notification preview line. Return null — or omit the hook — to use
   * the codec's own `fallback`, which is what a client without this codec sees.
   * Override only for copy the wire fallback can't carry, e.g. direction-aware
   * phrasing ("You sent" vs "Sent you"), which is viewer-relative and so must
   * not be baked into the stored message.
   */
  preview?(m: DecodedMessage, opts?: { fromMe?: boolean }): string | null;
  /**
   * Local notification for an inbound message of this type, or null when this
   * card isn't notify-worthy on its own (a passive context card rides along
   * with the text message that carries the push). Omit to never notify.
   */
  notification?(m: DecodedMessage): CardNotification | null;
}

/**
 * The chat message a `CardType` renders as: the caller's base shape plus the
 * card's `kind` discriminant and its payload under its own `payloadKey`.
 * Generic over `Base` rather than importing the chat hook's message type, so
 * this module stays ignorant of `useConversation.ts` — `CardMessage<C, Base>`
 * distributes over a union of descriptors (e.g. `(typeof theHostsCardTypes)[number]`,
 * the host's own registry array) into the union of their rendered message shapes.
 */
export type CardMessage<C, Base> =
  C extends CardType<infer K, infer T, infer P>
    ? Base & { kind: K } & { [Q in P]: T }
    : never;

/** The descriptor matching a decoded message, or null if it isn't one of ours. */
export function findCardType(
  registry: readonly CardType<any, any>[],
  m: DecodedMessage,
): CardType<any, any> | null {
  for (const card of registry) {
    if (card.is(m)) return card;
  }
  return null;
}

/**
 * Decoded, shape-checked payload for a message of this card type, or null if
 * `content()` throws (undecodable) or the payload fails the type's guard.
 */
export function decodeCard<T>(card: CardType<any, T>, m: DecodedMessage): T | null {
  try {
    const content = m.content();
    if (card.isValid(content)) return content;
  } catch {
    // undecodable — the caller falls back to the message's text fallback
  }
  return null;
}

/** `notification` hook for a card whose codec `fallback` is a good body as-is. */
export function fallbackNotification(m: DecodedMessage): CardNotification | null {
  return m.fallback ? { body: m.fallback } : null;
}
