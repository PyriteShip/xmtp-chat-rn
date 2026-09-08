/**
 * Structured description of an XMTP message, for the inbox row, the
 * notification body and the unread tally.
 *
 * The description names WHAT a message is; the copy that renders it lives with
 * the host, so the transport layer carries no
 * user-facing strings and no locale. A card's `preview` is the one string that
 * passes through here, and it came from that card type's own app-supplied
 * `preview` hook — this module never authors it.
 *
 * `isPreviewable` is the emptiness test every unread calculation uses. Two
 * states read as nothing: un-reacting (not news worth a row update) and a card
 * with neither a preview nor a wire fallback. Both describe as `none`, so an
 * unread dot can never appear beside a blank row.
 */

import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { decodeReaction, decodeReply, isReaction, isReply } from './replyReaction';
import { findCardType } from './cardRegistry';
import { xmtpConfig } from './configure';

export type MessageDescription =
  | { kind: 'text'; text: string }
  | { kind: 'reaction'; emoji: string; fromMe: boolean }
  | { kind: 'card'; cardKind: string; preview: string | null; fallback: string }
  | { kind: 'none' };

export function decodedMessageText(m: DecodedMessage | undefined | null): string {
  if (!m) return '';
  // A quoted reply is text that happens to name what it answers. Every consumer
  // wants the text the person typed, not the wrapper, so it is unwrapped before
  // the plain-text path.
  const reply = decodeReply(m);
  if (reply) return reply.text;
  try {
    const content = m.content();
    if (typeof content === 'string' && content.trim() !== '') return content;
  } catch {
    // non-text content type — fall through
  }
  return '';
}

export function describeMessage(
  m: DecodedMessage | undefined | null,
  opts?: { fromMe?: boolean },
): MessageDescription {
  const text = decodedMessageText(m);
  if (text) return { kind: 'text', text };
  if (!m) return { kind: 'none' };

  if (isReaction(m)) {
    const reaction = decodeReaction(m);
    if (!reaction || reaction.action !== 'added') return { kind: 'none' };
    return { kind: 'reaction', emoji: reaction.content, fromMe: !!opts?.fromMe };
  }

  const card = findCardType(xmtpConfig().cards, m);
  if (card) {
    return {
      kind: 'card',
      cardKind: card.kind,
      preview: card.preview?.(m, opts) ?? null,
      fallback: m.fallback ?? '',
    };
  }

  // `isReply` reaches here only when the reply's payload wasn't text (an
  // attachment reply from another client) — a text reply already unwrapped
  // above. Its fallback beats an empty row.
  if (isReply(m)) {
    return m.fallback
      ? { kind: 'card', cardKind: 'reply', preview: null, fallback: m.fallback }
      : { kind: 'none' };
  }

  return { kind: 'none' };
}

export function isPreviewable(d: MessageDescription): boolean {
  switch (d.kind) {
    case 'text': return d.text.trim() !== '';
    case 'reaction': return true;
    case 'card': return (d.preview ?? d.fallback) !== '';
    case 'none': return false;
  }
}
