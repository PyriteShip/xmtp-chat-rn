/**
 * Detection + decoding for XMTP's two native "message about a message" content
 * types: `xmtp.org/reply` and `xmtp.org/reaction`.
 *
 * Both codecs ship with the SDK (`ReplyCodec`, `ReactionCodec`,
 * `ReactionV2Codec`) and are registered by client.ts's `codecs()`, so the
 * payloads arrive already decoded on the native side. These helpers take the same
 * shape a host's own card `is` predicates do: a cheap contentTypeId prefix test
 * plus a throw-safe decode.
 *
 * A reply's payload nests the replied-with content, which the SDK types as
 * `NativeMessageContent` — only native types (text, attachments) can ride
 * inside one, never a host's JSON card codecs. Text replies are carried and the
 * rest dropped, which is exactly what a composer can produce.
 *
 * Reactions come in two wire versions. v2 is what we send; v1 is decoded too so
 * a reaction from an older client still lands on the right bubble. Both carry
 * the same `ReactionContent` shape, so one decoder covers them.
 */

import type { DecodedMessage, ReactionContent } from '@xmtp/react-native-sdk';

/** "xmtp.org/reply:1.0" */
const REPLY_TYPE_PREFIX = 'xmtp.org/reply';
/** "xmtp.org/reaction:1.0" and ":2.0" */
const REACTION_TYPE_PREFIX = 'xmtp.org/reaction';

/** The subset of the SDK's ReplyContent we can render (text replies only). */
export interface ReplyPayload {
  /** Message id of the message being replied to. */
  reference: string;
  /** The reply's own text. */
  text: string;
}

function hasTypePrefix(m: DecodedMessage, prefix: string): boolean {
  return typeof m.contentTypeId === 'string' && m.contentTypeId.startsWith(prefix);
}

export function isReply(m: DecodedMessage): boolean {
  return hasTypePrefix(m, REPLY_TYPE_PREFIX);
}

export function isReaction(m: DecodedMessage): boolean {
  return hasTypePrefix(m, REACTION_TYPE_PREFIX);
}

/**
 * A text reply's reference + text, or null when the message isn't a reply, the
 * decode throws, or the replied-with content isn't text (an attachment reply
 * from another client). Callers fall back to the codec `fallback` string.
 */
export function decodeReply(m: DecodedMessage): ReplyPayload | null {
  if (!isReply(m)) return null;
  try {
    const content = m.content() as { reference?: unknown; content?: unknown } | undefined;
    if (!content || typeof content.reference !== 'string' || !content.reference) return null;
    // The nested content is a NativeMessageContent; a text reply carries it
    // either as a bare string or under the `text` key depending on how far up
    // the bridge decoded it.
    const inner = content.content;
    const text =
      typeof inner === 'string'
        ? inner
        : typeof (inner as { text?: unknown })?.text === 'string'
          ? ((inner as { text: string }).text)
          : null;
    if (text === null || text.trim() === '') return null;
    return { reference: content.reference, text };
  } catch {
    return null;
  }
}

/**
 * A reaction's payload, or null when the message isn't one, the decode throws,
 * or it carries nothing renderable as a pill.
 *
 * `reference` is deliberately NOT required here. A reaction fetched as a
 * `childMessages` entry is already scoped to its parent, so the caller supplies
 * the parent id and an unpopulated reference costs nothing; a reaction arriving
 * on the top-level stream has no such context, so that caller requires it.
 *
 * Non-unicode schemas (shortcode, custom) are dropped: the pill row renders the
 * payload verbatim, and a `:thumbsup:` pill would read as broken text.
 */
export function decodeReaction(m: DecodedMessage): ReactionContent | null {
  if (!isReaction(m)) return null;
  try {
    const content = m.content() as ReactionContent | undefined;
    if (!content || typeof content.content !== 'string' || content.content === '') return null;
    if (content.action !== 'added' && content.action !== 'removed') return null;
    if (content.schema !== 'unicode') return null;
    return content;
  } catch {
    return null;
  }
}
