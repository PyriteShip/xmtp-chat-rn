/**
 * Recognizing and decoding XMTP's standard remote attachment.
 *
 * The attachment itself lives outside XMTP: the message carries an https URL
 * to ciphertext plus the key to decrypt it. That makes this decoder the guard
 * for everything downstream — content that names a URL other clients can't
 * fetch, or that lacks the key material, decodes to null here rather than
 * becoming a bubble that fails only when someone taps it.
 *
 * Pure and client-free on purpose, so `describeMessage` can use it without
 * importing the client lifecycle.
 */

import type { DecodedMessage, RemoteAttachmentContent } from '@xmtp/react-native-sdk';

export const REMOTE_ATTACHMENT_TYPE_PREFIX = 'xmtp.org/remoteStaticAttachment:';

export function isRemoteAttachment(m: DecodedMessage | undefined | null): boolean {
  return typeof m?.contentTypeId === 'string' && m.contentTypeId.startsWith(REMOTE_ATTACHMENT_TYPE_PREFIX);
}

// The inline variant (bytes on the wire, no upload) — sent by other clients;
// we don't render its inline bytes in v1 (see codecs() in client.ts), so
// callers show its fallback rather than silently dropping the message.
export const STATIC_ATTACHMENT_TYPE_PREFIX = 'xmtp.org/attachment:';

export function isStaticAttachment(m: DecodedMessage | undefined | null): boolean {
  return typeof m?.contentTypeId === 'string' && m.contentTypeId.startsWith(STATIC_ATTACHMENT_TYPE_PREFIX);
}

// Several files in one message (MultiRemoteAttachmentCodec) — registered in
// codecs() so it decodes instead of landing as an unknown content type, but
// rendering the individual files is out of scope here; callers treat it
// exactly like an inline static attachment above and show its text fallback.
export const MULTI_REMOTE_ATTACHMENT_TYPE_PREFIX = 'xmtp.org/multiRemoteStaticAttachment:';

export function isMultiRemoteAttachment(m: DecodedMessage | undefined | null): boolean {
  return typeof m?.contentTypeId === 'string' && m.contentTypeId.startsWith(MULTI_REMOTE_ATTACHMENT_TYPE_PREFIX);
}

export function decodeRemoteAttachment(
  m: DecodedMessage | undefined | null,
): RemoteAttachmentContent | null {
  if (!m || !isRemoteAttachment(m)) return null;
  let content: Partial<RemoteAttachmentContent> | null;
  try {
    content = m.content() as Partial<RemoteAttachmentContent> | null;
  } catch {
    return null;
  }
  if (!content || typeof content.url !== 'string' || !content.url.startsWith('https://')) return null;
  if (!content.secret || !content.salt || !content.nonce || !content.contentDigest) return null;
  return content as RemoteAttachmentContent;
}
