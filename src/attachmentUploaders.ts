/**
 * Ready-made `attachments.upload` implementations for the two storage shapes
 * the README recommends. Both keep credentials off the device: the host's own
 * server presigns the S3/R2 upload or performs the IPFS pin, and the app only
 * ever holds a single-use URL.
 *
 * Neither adapter needs a download counterpart from this package — any https
 * GET that writes to a file works; the README shows one with expo-file-system.
 */

import type { AttachmentUpload, XmtpAttachmentsConfig } from './configure';

type Upload = XmtpAttachmentsConfig['upload'];

/**
 * Read a local file as a Blob through React Native's fetch. Verified on device
 * in the release check; pass your own `readFile` (e.g. expo-file-system's
 * `File`, which is a Blob) if your runtime's fetch can't read file:// URIs.
 */
export async function readLocalFile(fileUri: string): Promise<Blob> {
  const res = await fetch(fileUri);
  return res.blob();
}

export interface PresignedPut {
  /** Single-use signed URL the ciphertext is PUT to. */
  uploadUrl: string;
  /** Permanent public https URL the object is readable at afterwards. */
  publicUrl: string;
  /** Headers the signature covers, if any. */
  headers?: Record<string, string>;
}

/** S3, R2, GCS or MinIO: `presign` asks your server for a signed PUT. */
export function createPresignedPutUploader(
  presign: (file: AttachmentUpload) => Promise<PresignedPut>,
  opts: { readFile?: (fileUri: string) => Promise<Blob> } = {},
): Upload {
  const readFile = opts.readFile ?? readLocalFile;
  return async (file) => {
    const target = await presign(file);
    const body = await readFile(file.encryptedFileUri);
    const res = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...target.headers },
      body,
    });
    if (!res.ok) throw new Error(`Attachment upload failed: HTTP ${res.status}`);
    return target.publicUrl;
  };
}

/**
 * IPFS through a pinning service. `pin` stores the ciphertext however your
 * provider wants (typically via your server) and resolves the CID; the URL
 * sent is on your `gateway`, because XMTP clients fetch https, not ipfs://.
 * Read the README's note on permanence before choosing this.
 */
export function createIpfsUploader(opts: {
  pin: (file: AttachmentUpload) => Promise<string>;
  gateway: string;
}): Upload {
  if (!opts.gateway.startsWith('https://')) {
    throw new Error(`IPFS gateway must be an https:// URL, got ${opts.gateway}`);
  }
  const gateway = opts.gateway.replace(/\/+$/, '');
  return async (file) => `${gateway}/ipfs/${await opts.pin(file)}`;
}
