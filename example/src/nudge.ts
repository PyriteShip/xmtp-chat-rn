/**
 * The example's one custom content type: a "nudge" — a short note that renders
 * as its own bubble instead of a text bubble.
 *
 * Two halves, and the split is the point. The codec is plain XMTP: an id, a
 * JSON body, and a `fallback` string that any other XMTP client shows when it
 * has never heard of this type. The `CardType` descriptor below is what
 * `xmtp-chat-rn` needs on top of that — how to recognise the type on the wire,
 * how to validate a decoded payload, and how to preview it in an inbox row.
 *
 * Register it in `configureXmtpChat({ cards })` and the client, the thread
 * hook, the inbox listing and the notification stream all learn about it at
 * once. A real app's registry (an invoice, an offer, a receipt) is this file
 * repeated, not a new integration each time.
 */

import { Buffer } from 'buffer';
import type {
  ContentTypeId,
  DecodedMessage,
  EncodedContent,
  JSContentCodec,
} from '@xmtp/react-native-sdk';
import { fallbackNotification, type CardType } from 'xmtp-chat-rn';

export interface Nudge {
  note: string;
}

const NUDGE_CONTENT_TYPE: ContentTypeId = {
  authorityId: 'example.xmtp-chat-rn',
  typeId: 'nudge',
  versionMajor: 1,
  versionMinor: 0,
};

/** "example.xmtp-chat-rn/nudge:1.0" — what DecodedMessage.contentTypeId reads. */
const NUDGE_TYPE_PREFIX = 'example.xmtp-chat-rn/nudge';

export class NudgeCodec implements JSContentCodec<Nudge> {
  contentType = NUDGE_CONTENT_TYPE;

  encode(content: Nudge): EncodedContent {
    return {
      type: NUDGE_CONTENT_TYPE,
      parameters: {},
      content: Buffer.from(JSON.stringify(content), 'utf8'),
    };
  }

  decode(encoded: EncodedContent): Nudge {
    return JSON.parse(Buffer.from(encoded.content).toString('utf8'));
  }

  /** What a client without this codec — another XMTP app — shows instead. */
  fallback(content: Nudge): string {
    return `Nudge: ${content.note}`;
  }

  shouldPush(): boolean {
    return true;
  }
}

export const nudgeCard: CardType<'nudge', Nudge, 'nudge'> = {
  kind: 'nudge',
  payloadKey: 'nudge',
  codec: new NudgeCodec(),
  is: (m) => (m.contentTypeId ?? '').startsWith(NUDGE_TYPE_PREFIX),
  isValid: (c): c is Nudge => !!c && typeof (c as Nudge).note === 'string',
  // No `preview` hook: the codec's own fallback already reads correctly to both
  // parties, so there is nothing direction-aware to say. `notification` reuses
  // that same fallback rather than inventing separate push copy.
  notification: fallbackNotification,
};

/** Every custom content type this app sends. */
export const EXAMPLE_CARDS = [nudgeCard] as const;
