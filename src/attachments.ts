/**
 * Attachment I/O: encrypt-then-upload on send, download-then-decrypt on open.
 *
 * The SDK does the cryptography (a random key per file, AES-256-GCM, whose
 * authentication tag also rejects a tampered download). This module is the
 * contract around the host's storage hooks: the size limit is enforced before
 * anything leaves the device, an upload must come back as an https URL other
 * XMTP clients can fetch, and each file downloads once per session.
 *
 * Decrypted files are cached in memory by content digest + secret (see
 * `openCacheKey`). The sender's own upload is primed with the original local
 * file, so their bubble never downloads what they just sent. That in-memory
 * cache is not persisted, but the FILE it points at is not ephemeral: on
 * every `decryptAttachment` call, the native SDK unconditionally writes the
 * decrypted plaintext to the OS temp directory
 * (`FileManager.default.temporaryDirectory` on iOS, `File.createTempFile` on
 * Android) and this module never deletes it. A host that cares about
 * decrypted plaintext lingering on disk after the session ends needs to
 * clean up `DecryptedLocalAttachment.fileUri` itself.
 */

import type { DecryptedLocalAttachment, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import { getActiveXmtpClient } from './client';
import { xmtpConfig, type XmtpAttachmentsConfig } from './configure';
import { opened, openCacheKey, clearAttachmentCache } from './attachmentCache';

// Re-exported rather than re-implemented: `openCacheKey` and
// `clearAttachmentCache` live in `attachmentCache.ts` (see that module's
// comment for why), but this is still where the package's other attachment
// code — and `useAttachment.ts`, and this file's own tests — import them
// from.
export { openCacheKey, clearAttachmentCache };

export const DEFAULT_ATTACHMENT_MAX_BYTES = 25_000_000;

/** A file on this device, as the host's picker produced it. */
export interface LocalAttachmentFile {
  /** Must be a file:// URI — the SDK refuses anything else. */
  fileUri: string;
  mimeType: string;
  filename?: string;
  /**
   * The plaintext file's byte length, if the caller's picker reports one
   * (e.g. `expo-image-picker`'s `fileSize`). When present, `uploadAttachment`
   * checks it against `maxBytes` BEFORE calling `client.encryptAttachment` —
   * which is what makes `maxBytes` an actual memory guard against a huge
   * pick, rather than only a backstop that fires after the native SDK has
   * already read and encrypted the whole file into memory. Omit it and the
   * limit still applies, but only via that post-encryption check.
   */
  byteLength?: number;
}

/**
 * Thrown when a file's size exceeds `maxBytes`. Retrying cannot fix it.
 *
 * Two different checks can throw this. When `LocalAttachmentFile.byteLength`
 * is set, it is checked BEFORE `client.encryptAttachment` runs — a real
 * memory guard, since it rejects an oversized pick before anything is read
 * into memory. Absent it, the only check is against the native SDK's
 * reported size — the PLAINTEXT attachment's byte length, approximately but
 * not exactly the stored ciphertext's size — AFTER `encryptAttachment` has
 * already read the whole file into memory; that is a backstop against
 * oversized uploads, not a guard against the memory cost of encrypting a
 * large file. Pass `byteLength` (e.g. from `expo-image-picker`'s `fileSize`)
 * to get the former.
 */
export class AttachmentTooLargeError extends Error {
  constructor(readonly byteLength: number, readonly maxBytes: number) {
    super(`Attachment is ${byteLength} bytes; the limit is ${maxBytes}`);
    this.name = 'AttachmentTooLargeError';
  }
}

/**
 * Thrown by `uploadAttachment`/`openAttachment` when `attachments` was never
 * passed to `configureXmtpChat`. Retrying cannot fix it either — like
 * `AttachmentTooLargeError`, the caller (`deliverAttachment`) discards the
 * local bubble instead of leaving a `failed` one whose retry can never work.
 */
export class AttachmentsNotConfiguredError extends Error {
  constructor() {
    super('Attachments are off: pass `attachments` to configureXmtpChat');
    this.name = 'AttachmentsNotConfiguredError';
  }
}

function attachmentsConfig(): XmtpAttachmentsConfig {
  const attachments = xmtpConfig().attachments;
  if (!attachments) {
    throw new AttachmentsNotConfiguredError();
  }
  return attachments;
}

function activeClient() {
  const client = getActiveXmtpClient();
  if (!client) throw new Error('Messaging unavailable');
  return client;
}

export async function uploadAttachment(file: LocalAttachmentFile): Promise<RemoteAttachmentContent> {
  const config = attachmentsConfig();
  const client = activeClient();
  const maxBytes = config.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  // When the caller supplies the plaintext size up front, reject an oversized
  // file before it is ever read into memory — this is the check that makes
  // `maxBytes` a real memory guard rather than just a backstop. Without it,
  // only the post-encryption check below runs, after the SDK has already
  // paid that memory cost.
  // `Number.isFinite`, not `!== undefined`: a caller can pass NaN/Infinity/-1
  // (TS's `number` type doesn't stop a bad value at runtime), and comparing
  // one of those against `maxBytes` either throws with a nonsensical byte
  // count or silently fails to flag anything. Excluding non-finite values up
  // front means garbage input falls through to the post-encryption check
  // (which validates the SDK's own reported size) instead of doing either.
  if (Number.isFinite(file.byteLength) && (file.byteLength as number) > maxBytes) {
    throw new AttachmentTooLargeError(file.byteLength as number, maxBytes);
  }
  const encrypted = await client.encryptAttachment(file);
  // `contentLength` is the native SDK's count of the PLAINTEXT attachment
  // bytes, not the ciphertext at `encryptedLocalFileUri` — the ciphertext is
  // somewhat larger (the encoded-content wrapper plus the GCM auth tag). This
  // check, and the `byteLength` a host's `upload` receives, are therefore
  // approximate, not the exact size of what gets PUT.
  const reported = Number(encrypted.metadata.contentLength);
  const byteLength = Number.isFinite(reported) ? reported : null;
  if (byteLength !== null && byteLength > maxBytes) {
    throw new AttachmentTooLargeError(byteLength, maxBytes);
  }
  const url = await config.upload({
    encryptedFileUri: encrypted.encryptedLocalFileUri,
    byteLength,
    contentDigest: encrypted.metadata.contentDigest,
  });
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new Error(`attachments.upload must resolve an https:// URL, got ${String(url)}`);
  }
  // Native `encryptAttachment` ignores the filename we pass — iOS's
  // `XMTPModule.swift` uses `url.lastPathComponent`, Android's `XMTPModule.kt`
  // uses `uri.lastPathSegment` — so `encrypted.metadata.filename` is the
  // picker's temp name, not what the user picked. Ours wins when we have one.
  const metadata = { ...encrypted.metadata, filename: file.filename ?? encrypted.metadata.filename };
  opened.set(openCacheKey(metadata), Promise.resolve(file));
  return { ...metadata, url, scheme: 'https://' };
}

export function openAttachment(content: RemoteAttachmentContent): Promise<DecryptedLocalAttachment> {
  const key = openCacheKey(content);
  const cached = opened.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const config = attachmentsConfig();
    const client = activeClient();
    const encryptedLocalFileUri = await config.download(content.url);
    const { url: _url, scheme: _scheme, ...metadata } = content;
    return client.decryptAttachment({ encryptedLocalFileUri, metadata });
  })();
  opened.set(key, pending);
  // A failure must not stick: the next open (a Retry tap) downloads afresh.
  pending.catch(() => {
    if (opened.get(key) === pending) opened.delete(key);
  });
  return pending;
}
