/**
 * Attachment I/O: encrypt-then-upload on send, download-then-decrypt on open.
 *
 * The SDK does the cryptography (a random key per file, AES-256-GCM, whose
 * authentication tag also rejects a tampered download). This module is the
 * contract around the host's storage hooks: the size limit is enforced before
 * anything leaves the device, an upload must come back as an https URL other
 * XMTP clients can fetch, and each file downloads once per session.
 *
 * Decrypted files are cached in memory by content digest. The sender's own
 * upload is primed with the original local file, so their bubble never
 * downloads what they just sent. The cache is not persisted: decrypted
 * plaintext on disk outliving the session is a decision for the host.
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

/** Thrown when ciphertext exceeds `maxBytes`. Retrying cannot fix it. */
export class AttachmentTooLargeError extends Error {
  constructor(readonly byteLength: number, readonly maxBytes: number) {
    super(`Attachment is ${byteLength} bytes; the limit is ${maxBytes}`);
    this.name = 'AttachmentTooLargeError';
  }
}

function attachmentsConfig(): XmtpAttachmentsConfig {
  const attachments = xmtpConfig().attachments;
  if (!attachments) {
    throw new Error('Attachments are off: pass `attachments` to configureXmtpChat');
  }
  return attachments;
}

function activeClient() {
  const client = getActiveXmtpClient();
  if (!client) throw new Error('Messaging unavailable');
  return client;
}

const opened = new Map<string, Promise<DecryptedLocalAttachment>>();

export async function uploadAttachment(file: LocalAttachmentFile): Promise<RemoteAttachmentContent> {
  const config = attachmentsConfig();
  const client = activeClient();
  const encrypted = await client.encryptAttachment(file);
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
  opened.set(encrypted.metadata.contentDigest, Promise.resolve(file));
  return { ...encrypted.metadata, url, scheme: 'https://' };
}

export function openAttachment(content: RemoteAttachmentContent): Promise<DecryptedLocalAttachment> {
  const key = content.contentDigest;
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
