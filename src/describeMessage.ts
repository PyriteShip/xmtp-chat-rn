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
 *
 * An attachment describes by filename only; the host words it ("📎 photo.jpg", "You sent a file").
 * That `attachment` kind only appears once the host has configured
 * `attachments` (see `configureXmtpChat`) — without it, a remote attachment
 * describes as a `card` carrying the codec's fallback instead, so a host that
 * never opted in still gets a row to show rather than a kind it doesn't know.
 */

import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { decodeRemoteAttachment, isStaticAttachment } from './attachmentContent';
import { decodeReaction, decodeReply, isReaction, isReply } from './replyReaction';
import { findCardType } from './cardRegistry';
import { xmtpConfig } from './configure';

export type MessageDescription =
  | { kind: 'text'; text: string }
  | { kind: 'reaction'; emoji: string; fromMe: boolean }
  | { kind: 'attachment'; filename: string | null; fromMe: boolean }
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

  // A remote attachment describes as its own kind only once the host has
  // opted into `attachments` — without that, this host can't render or open
  // one, so it degrades to the `card` case below like any other content type
  // this build can't act on, carrying the codec's fallback rather than a
  // kind the inbox row doesn't know how to word. 'remoteAttachment', not
  // 'attachment' — that name is the first-class kind a configured host gets.
  const attachment = decodeRemoteAttachment(m);
  if (attachment) {
    if (!xmtpConfig().attachments) {
      return m.fallback
        ? { kind: 'card', cardKind: 'remoteAttachment', preview: null, fallback: m.fallback }
        : { kind: 'none' };
    }
    return { kind: 'attachment', filename: attachment.filename ?? null, fromMe: !!opts?.fromMe };
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

  // An inline static attachment (sent by another client — we only ever send
  // the remote variant) carries its bytes on the wire; we don't render those
  // in v1, so its fallback beats a silently missing row, same as any other
  // non-text content type below.
  if (isStaticAttachment(m)) {
    // 'staticAttachment', not 'attachment' — that name is the first-class
    // ChatMessage kind a decodable remote attachment produces; this fallback
    // card must not collide with it.
    return m.fallback
      ? { kind: 'card', cardKind: 'staticAttachment', preview: null, fallback: m.fallback }
      : { kind: 'none' };
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
    case 'attachment': return true;
    case 'card': return (d.preview ?? d.fallback) !== '';
    case 'none': return false;
  }
}
