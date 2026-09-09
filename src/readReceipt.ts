/**
 * XMTP's native read-receipt content type (`xmtp.org/readReceipt`).
 *
 * A receipt is an empty payload whose only information is its own `sentNs`:
 * "I have read everything in this conversation up to here". The codec ships
 * with the SDK and is registered by client.ts's `codecs()`, so receipts arrive
 * already decoded — these helpers mirror the shape of replyReaction.ts, a cheap
 * contentTypeId prefix test plus a throw-safe send.
 *
 * Two properties of the wire type matter to callers. Its `shouldPush` is false,
 * so a receipt never wakes the counterparty's device. And its `fallback` is
 * undefined, so a client without the codec renders nothing at all rather than
 * an "unsupported message" row — which is also why describeMessage must map it
 * to `none` rather than relying on a fallback string.
 */

import { ReadReceiptCodec, type DecodedMessage } from '@xmtp/react-native-sdk';
import { xmtpConfig } from './configure';

/** "xmtp.org/readReceipt:1.0" */
const READ_RECEIPT_TYPE_PREFIX = 'xmtp.org/readReceipt';

const readReceiptContentType = new ReadReceiptCodec().contentType;

export function isReadReceipt(m: DecodedMessage): boolean {
  return (
    typeof m?.contentTypeId === 'string' && m.contentTypeId.startsWith(READ_RECEIPT_TYPE_PREFIX)
  );
}

/**
 * Tell the counterparty this conversation is read up to now. Best-effort: a
 * receipt is a courtesy, so a failure here is swallowed rather than surfaced —
 * the local read watermark has already advanced and the user is, in fact,
 * reading the thread. Never rejects.
 */
export async function sendReadReceipt(dm: { send: Function }): Promise<void> {
  try {
    await dm.send({}, { contentType: readReceiptContentType });
  } catch {
    // A receipt that doesn't land changes nothing the reader can see.
  }
}

/**
 * Whether an arriving message should be acknowledged with a receipt.
 *
 * The first clause is the one that matters: a read receipt must never provoke a
 * read receipt. Both sides run this code, so acking an ack would have each
 * client answering the other's answer without end — a message per round, on a
 * network where every message is a permanent MLS commit.
 *
 * The rest are ordinary: only when the host opted in, only when the watermark
 * actually moved (so re-opening a read thread is silent), and never for our own
 * messages, which have nobody to inform.
 */
export function shouldSendReadReceipt(
  m: DecodedMessage,
  opts: { advanced: boolean; fromMe: boolean },
): boolean {
  if (isReadReceipt(m)) return false;
  if (!opts.advanced || opts.fromMe) return false;
  return xmtpConfig().readReceipts === true;
}
