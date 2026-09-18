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
 * Read a local file as a Blob through React Native's fetch. The
 * `fetch(file://)`-to-Blob path is not verified on every platform; if it
 * fails on yours, pass your own `readFile` (e.g. expo-file-system's `File`,
 * which is a Blob) instead.
 */
export async function readLocalFile(fileUri: string): Promise<Blob> {
  const res = await fetch(fileUri);
  return res.blob();
}

/**
 * Both uploaders below default to this. Ciphertext upload is one PUT/POST —
 * there is nothing to resume or retry mid-transfer — so a single bound is
 * enough; unlike client creation there's no wallet signature to wait on, but
 * mobile networks stall, so 60s (matching `DEFAULT_CLIENT_CREATE_TIMEOUT_MS`)
 * is generous rather than tight.
 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Runs `fetch` bounded by `timeoutMs` (default `DEFAULT_UPLOAD_TIMEOUT_MS`;
 * `0` or negative disables the bound), then hands the response to
 * `onResponse` — still inside the same bound. `AbortController` is how
 * `fetch` itself supports cancellation, so that's what carries the deadline
 * in; without it a hung upload never settles and the caller
 * (`uploadAttachment`) leaves the bubble pending forever with no error to
 * log.
 *
 * The timer is not cleared until `onResponse` itself settles. `fetch()`'s own
 * promise resolves as soon as HEADERS arrive — well before a body most
 * callers still need to read (`res.json()`, `res.text()`, ...) — so clearing
 * the timer right after `fetch()` resolves would let a response that stalls
 * mid-body escape the bound entirely: exactly the failure this timeout
 * exists to prevent. Aborting a still-open request also aborts its response
 * body stream, so `onResponse`'s read rejects at the same deadline an
 * unresolved `fetch()` would have.
 *
 * A non-abort rejection (DNS failure, connection refused, a non-timeout error
 * `onResponse` throws, etc.) is rethrown unchanged — only a rejection that
 * lines up with our own abort is remapped, so a caller-supplied signal firing
 * for an unrelated reason isn't misreported as a timeout. (Neither uploader
 * here takes a caller signal today, but the check costs nothing and keeps
 * this helper honest if one is added later.)
 */
async function fetchWithTimeout<T>(
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs: number | undefined,
  onResponse: (res: Response) => Promise<T>,
): Promise<T> {
  const ms = timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  if (!(ms > 0)) return onResponse(await fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await onResponse(res);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Attachment upload timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  opts: {
    readFile?: (fileUri: string) => Promise<Blob>;
    /** Defaults to `DEFAULT_UPLOAD_TIMEOUT_MS`; `0` or negative disables it. */
    timeoutMs?: number;
  } = {},
): Upload {
  const readFile = opts.readFile ?? readLocalFile;
  return async (file) => {
    const target = await presign(file);
    const body = await readFile(file.encryptedFileUri);
    return fetchWithTimeout(
      target.uploadUrl,
      { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...target.headers }, body },
      opts.timeoutMs,
      async (res) => {
        if (!res.ok) throw new Error(`Attachment upload failed: HTTP ${res.status}`);
        return target.publicUrl;
      },
    );
  };
}

export interface ProxyUploadResponse {
  url: string;
}

/**
 * For a host whose server holds the storage binding itself (e.g. a
 * Cloudflare Worker with an R2 binding) rather than presigning a URL for the
 * device to PUT to directly — so no storage credentials, presigned or
 * otherwise, exist anywhere the device can see. The device instead POSTs (or
 * PUTs) the ciphertext straight to `endpoint`, and the response names the
 * https URL the object ends up at.
 *
 * The digest and byte length ride as headers (`x-attachment-digest`,
 * `x-attachment-bytes`) rather than as part of the body: a Worker deciding
 * whether to accept the upload, or choosing the R2 object key, needs that
 * information before (or without) buffering and parsing a body that may be
 * tens of megabytes, and a streamed request's body isn't necessarily
 * available to inspect ahead of the handler reading it anyway. Headers are
 * always available synchronously at request time.
 *
 * The two headers describe different things and neither is a substitute for
 * the other. `x-attachment-digest` is the SHA-256 of the CIPHERTEXT this
 * request's body actually is — authoritative and safe to use as the object's
 * storage key, but only once your server has verified it against the bytes
 * received (see the README's Worker example); trusting the header as sent is
 * an overwrite vector, since any caller can name any key. `x-attachment-bytes`
 * is the native SDK's reported PLAINTEXT size, not this body's (ciphertext)
 * length — approximate and non-authoritative, so don't compare it to
 * `Content-Length` or enforce a storage quota with it; the two will disagree
 * by the encoded-content wrapper plus the GCM auth tag, and it may be absent
 * (`byteLength: null`) entirely.
 */
export function createProxyUploader(opts: {
  /** Your endpoint. Receives the ciphertext as the request body. */
  endpoint: string;
  /** Per-request auth/metadata headers, awaited per upload so a token can be refreshed. */
  headers?: (file: AttachmentUpload) => Promise<Record<string, string>> | Record<string, string>;
  /** Defaults to POST. */
  method?: 'POST' | 'PUT';
  /** Pull the public https URL out of your endpoint's response. Defaults to `(await res.json()).url`. */
  publicUrl?: (res: Response) => Promise<string> | string;
  readFile?: (fileUri: string) => Promise<Blob>;
  /** Defaults to `DEFAULT_UPLOAD_TIMEOUT_MS`; `0` or negative disables it. */
  timeoutMs?: number;
}): Upload {
  const readFile = opts.readFile ?? readLocalFile;
  const method = opts.method ?? 'POST';
  const resolvePublicUrl =
    opts.publicUrl ?? (async (res: Response) => ((await res.json()) as ProxyUploadResponse).url);
  return async (file) => {
    const body = await readFile(file.encryptedFileUri);
    // Caller headers first, fixed ones last — a `headers` callback can't
    // accidentally clobber the content type or the metadata the server
    // relies on to authorize/key the object. Caller keys are lowercased
    // before the merge: header names are case-insensitive on the wire, but
    // 'Content-Type' and 'content-type' are different JS object keys, so
    // without normalizing first, a caller returning a differently-cased
    // duplicate would survive the spread as a second key — which `Headers`
    // then combines with the fixed one instead of one overriding the other,
    // silently defeating the guarantee above.
    const custom = await (opts.headers ? opts.headers(file) : {});
    const normalizedCustom = Object.fromEntries(
      Object.entries(custom).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const headers: Record<string, string> = {
      ...normalizedCustom,
      'content-type': 'application/octet-stream',
      'x-attachment-digest': file.contentDigest,
      ...(file.byteLength !== null ? { 'x-attachment-bytes': String(file.byteLength) } : {}),
    };
    return fetchWithTimeout(opts.endpoint, { method, headers, body }, opts.timeoutMs, async (res) => {
      if (!res.ok) throw new Error(`Attachment upload failed: HTTP ${res.status}`);
      // resolvePublicUrl reads the response body (res.json() by default) —
      // done here, still inside fetchWithTimeout's try/finally, so a proxy
      // that returns 200 and then stalls the body is bounded by the same
      // timeout rather than hanging uploadAttachment forever.
      return resolvePublicUrl(res);
    });
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
