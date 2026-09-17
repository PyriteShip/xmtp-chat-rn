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

export const DEFAULT_ATTACHMENT_MAX_BYTES = 25_000_000;

/** A file on this device, as the host's picker produced it. */
export interface LocalAttachmentFile {
  /** Must be a file:// URI — the SDK refuses anything else. */
  fileUri: string;
  mimeType: string;
  filename?: string;
}

/**
 * Thrown when the native SDK's reported size — the PLAINTEXT attachment's
 * byte length, approximately but not exactly the stored ciphertext's size —
 * exceeds `maxBytes`. Retrying cannot fix it.
 *
 * This check runs after `client.encryptAttachment`, which has already read
 * the whole file into memory, so it is a backstop against oversized uploads,
 * not a guard against the memory cost of encrypting a large file. A host
 * that cares about that should check the picked file's size itself before
 * calling `sendAttachment`.
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

const opened = new Map<string, Promise<DecryptedLocalAttachment>>();

// Two RemoteAttachmentContent values can share a contentDigest (the plaintext
// hashes the same) while carrying different per-file secrets — the digest
// alone is not a safe cache key, since it would let one file's decrypted
// bytes be served back for the other's content. `secret` is unique per
// encryption, so the pair is.
function openCacheKey(content: Pick<RemoteAttachmentContent, 'contentDigest' | 'secret'>): string {
  return `${content.contentDigest}:${content.secret}`;
}

export async function uploadAttachment(file: LocalAttachmentFile): Promise<RemoteAttachmentContent> {
  const config = attachmentsConfig();
  const client = activeClient();
  const encrypted = await client.encryptAttachment(file);
  // `contentLength` is the native SDK's count of the PLAINTEXT attachment
  // bytes, not the ciphertext at `encryptedLocalFileUri` — the ciphertext is
  // somewhat larger (the encoded-content wrapper plus the GCM auth tag). This
  // check, and the `byteLength` a host's `upload` receives, are therefore
  // approximate, not the exact size of what gets PUT.
  const reported = Number(encrypted.metadata.contentLength);
  const byteLength = Number.isFinite(reported) ? reported : null;
  const maxBytes = config.maxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
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

/** Test seam. */
export function __resetAttachmentCache(): void {
  opened.clear();
}
