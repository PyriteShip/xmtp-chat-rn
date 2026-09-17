# Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send and receive file attachments as XMTP's standard remote attachment, with storage supplied by the host app (S3/R2 via presigned PUT by default, IPFS via a gateway as an opt-in).

**Architecture:** The sender's device encrypts the file with the SDK's `encryptAttachment` (a random per-file key, AES-256-GCM). The host's `upload` hook stores the ciphertext and returns a public `https://` URL. The message (`xmtp.org/remoteStaticAttachment:1.0`) carries the URL plus the key, and MLS encrypts that message to the conversation. On receipt, the host's `download` hook fetches the ciphertext to a local file and the SDK's `decryptAttachment` decrypts it. The package owns codec registration, the send/receive flow, delivery state, message description and a render hook. The host owns storage and the file system.

**Tech Stack:** TypeScript, React 19 hooks, `@xmtp/react-native-sdk` 5.7.0 (`RemoteAttachmentCodec`, `StaticAttachmentCodec`, `Client.encryptAttachment`, `Client.decryptAttachment`), Jest + babel-jest, `@testing-library/react-native`.

**Spec:** No separate spec file. The design was settled in conversation on 2026-09-17 and is recorded in "Design decisions" below. Executors read that section first.

## Design decisions

1. **Wire format is the XMTP standard only.** Send `remoteAttachment` content. Other XMTP clients (xmtp.chat, Convos, Base app) can decode it. Do not invent a custom attachment content type.
2. **Storage is a host hook, not a dependency.** `configureXmtpChat({ attachments: { upload, download, maxBytes } })`. The package ships no AWS, IPFS or Expo dependency.
3. **The URL must be permanent, public, CORS-open and `https://`.** Other clients do a plain GET with no headers. The SDK types `scheme` as `'https://'` only (`node_modules/@xmtp/react-native-sdk/src/lib/types/ContentCodec.ts:90`). The package rejects a non-https upload result.
4. **Two shipped uploader helpers:** `createPresignedPutUploader` (S3, R2, GCS, MinIO; the host's server issues the presigned URL, and credentials never ship in the app) and `createIpfsUploader` (the host pins the file through its own server, and the helper builds the `https://<gateway>/ipfs/<cid>` URL).
5. **The README documents the privacy model:** storage holds only ciphertext; the key travels inside the MLS-encrypted message; IPFS files can't be reliably deleted, so a leaked key exposes the file forever; deleting an S3/R2 object revokes access.
6. **Out of scope for v1:** multi-file messages (`MultiRemoteAttachmentCodec`), rendering inline `StaticAttachment` (the codec is registered so it decodes, and it shows its text fallback), a persistent decrypted-file cache, upload progress, thumbnails.
7. **Attachment sends are optimistic,** exactly like text: a local `pending` bubble, then `sent` on ack or `failed` on throw, with tap-to-retry. Exception: a file over `maxBytes` removes the bubble and makes `sendAttachment` reject with `AttachmentTooLargeError`, because retrying can never fix it.
8. **`attachment` becomes a reserved `ChatMessage` kind.** A host card registered with `kind: 'attachment'` would collide. Call this out in the CHANGELOG.

## Global Constraints

- Peer dependency floor stays `@xmtp/react-native-sdk ^5.7.0`; add no new runtime dependencies.
- No native code in this package (no `ios/`, `android/`, podspec).
- Tests load the SDK through the stub at `__mocks__/@xmtp/react-native-sdk.js` (mapped in `jest.config.js`). Any SDK value a new module imports must exist on that stub; type-only imports need nothing.
- Every `ContentTypeId` match uses the existing idiom: `typeof m?.contentTypeId === 'string' && m.contentTypeId.startsWith(PREFIX)` (`src/readReceipt.ts:27`).
- Default `maxBytes`: `25_000_000`.
- Verification commands: `npm run typecheck`, `npm test`, `npm run build`. All three must pass at the end of every task.
- Code comments follow the repo style: a doc comment explaining *why*, not *what*.

---

## File structure

| File | Responsibility |
|---|---|
| `src/attachmentContent.ts` (create) | Pure: is this message a remote attachment, and decode + validate its content. No client import, so `describeMessage` can use it without a cycle. |
| `src/attachments.ts` (create) | I/O: encrypt + upload (`uploadAttachment`), download + decrypt with an in-memory cache (`openAttachment`), `AttachmentTooLargeError`. |
| `src/attachmentUploaders.ts` (create) | Host-side helpers: `createPresignedPutUploader`, `createIpfsUploader`, `readLocalFile`. |
| `src/useAttachment.ts` (create) | Render hook: load state for one attachment. |
| `src/configure.ts` (modify) | `attachments` config + `AttachmentUpload` / `XmtpAttachmentsConfig` types. |
| `src/client.ts` (modify) | Register `RemoteAttachmentCodec` and `StaticAttachmentCodec`. |
| `src/describeMessage.ts` (modify) | New `attachment` description kind. |
| `src/deliveryState.ts` (modify) | Delivery tracking covers `attachment` messages; local attachment message; `attachUploaded`. |
| `src/useConversation.ts` (modify) | `attachment` branch in `ChatMessage`, `toChatMessage` decoding, `sendAttachment`, retry. |
| `src/index.ts` (modify) | Exports. |
| `__mocks__/@xmtp/react-native-sdk.js` (modify) | Codec stubs. |
| `README.md`, `CHANGELOG.md` (modify) | Docs. |

---

### Task 1: Decode remote attachments and describe them

**Files:**
- Create: `src/attachmentContent.ts`
- Create: `src/attachmentContent.test.ts`
- Modify: `__mocks__/@xmtp/react-native-sdk.js`
- Modify: `src/client.ts:12-20` (imports), `src/client.ts:48-56` (`codecs()`)
- Modify: `src/client.test.ts:146-152` (codecs describe block)
- Modify: `src/describeMessage.ts`
- Modify: `src/describeMessage.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `REMOTE_ATTACHMENT_TYPE_PREFIX: 'xmtp.org/remoteStaticAttachment:'`
  - `isRemoteAttachment(m: DecodedMessage | undefined | null): boolean`
  - `decodeRemoteAttachment(m: DecodedMessage | undefined | null): RemoteAttachmentContent | null`
  - `MessageDescription` gains `{ kind: 'attachment'; filename: string | null; fromMe: boolean }`

- [ ] **Step 1: Add codec stubs to the SDK mock**

In `__mocks__/@xmtp/react-native-sdk.js`, after `class ReadReceiptCodec { ... }`:

```js
class RemoteAttachmentCodec {
  contentType = { authorityId: 'xmtp.org', typeId: 'remoteStaticAttachment', versionMajor: 1, versionMinor: 0 };
}
class StaticAttachmentCodec {
  contentType = { authorityId: 'xmtp.org', typeId: 'attachment', versionMajor: 1, versionMinor: 0 };
}
```

and add both to `module.exports`:

```js
module.exports = {
  Client, PublicIdentity, XMTPPush,
  ReplyCodec, ReactionCodec, ReactionV2Codec, ReadReceiptCodec,
  RemoteAttachmentCodec, StaticAttachmentCodec,
};
```

- [ ] **Step 2: Write the failing decode tests**

Create `src/attachmentContent.test.ts`:

```ts
// A remote attachment is the one message whose content points outside XMTP, so
// its decoder is also the guard: a URL we can't fetch as https, or content
// missing the key material, must not become a bubble that fails on tap.
import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { decodeRemoteAttachment, isRemoteAttachment } from './attachmentContent';

const valid = {
  url: 'https://files.example/abc',
  scheme: 'https://',
  contentDigest: 'd1',
  secret: 's',
  salt: 'l',
  nonce: 'n',
  filename: 'photo.jpg',
  contentLength: '1024',
};

function msg(contentTypeId: string, content: unknown): DecodedMessage {
  return { contentTypeId, content: () => content } as unknown as DecodedMessage;
}

test('matches the standard remote attachment content type', () => {
  expect(isRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', valid))).toBe(true);
  expect(isRemoteAttachment(msg('xmtp.org/text:1.0', 'hi'))).toBe(false);
  expect(isRemoteAttachment(undefined)).toBe(false);
});

test('decodes valid content unchanged', () => {
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', valid))).toEqual(valid);
});

test('rejects a non-https url', () => {
  const content = { ...valid, url: 'ipfs://bafy' };
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', content))).toBeNull();
});

test('rejects content missing key material', () => {
  const { secret, ...noSecret } = valid;
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', noSecret))).toBeNull();
});

test('a content() that throws decodes to null', () => {
  const m = {
    contentTypeId: 'xmtp.org/remoteStaticAttachment:1.0',
    content: () => { throw new Error('no codec'); },
  } as unknown as DecodedMessage;
  expect(decodeRemoteAttachment(m)).toBeNull();
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx jest src/attachmentContent.test.ts`
Expected: FAIL with `Cannot find module './attachmentContent'`

- [ ] **Step 4: Implement `src/attachmentContent.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx jest src/attachmentContent.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the failing codec registration test**

In `src/client.test.ts`, extend the SDK import to include the two codecs and add inside `describe('codecs', ...)`:

```ts
  test('registers both attachment codecs so other clients\' attachments decode', () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
    const registered = codecs();
    expect(registered.some((c: any) => c instanceof RemoteAttachmentCodec)).toBe(true);
    expect(registered.some((c: any) => c instanceof StaticAttachmentCodec)).toBe(true);
  });
```

(Match the configure call the neighboring read-receipt test uses. If that test configures in a `beforeEach`, drop the line here.)

- [ ] **Step 7: Run it and confirm it fails**

Run: `npx jest src/client.test.ts -t attachment`
Expected: FAIL, `expect(received).toBe(expected)` with `false`.

- [ ] **Step 8: Register the codecs**

In `src/client.ts`, add `RemoteAttachmentCodec` and `StaticAttachmentCodec` to the SDK import, then:

```ts
export function codecs() {
  return [
    new ReplyCodec(),
    new ReactionV2Codec(),
    new ReactionCodec(),
    new ReadReceiptCodec(),
    new RemoteAttachmentCodec(),
    new StaticAttachmentCodec(),
    ...xmtpConfig().cards.map((card) => card.codec),
  ];
}
```

Append one paragraph to the `codecs()` doc comment:

```ts
 * Both attachment codecs are registered whether or not the host configured
 * `attachments`, for the same reason as receipts: registration is what lets
 * another client's attachment decode instead of landing as an unknown type.
 * Only the remote one renders; an inline static attachment shows its fallback.
```

- [ ] **Step 9: Write the failing description tests**

Append to `src/describeMessage.test.ts`:

```ts
test('a remote attachment describes by filename, direction carried', () => {
  const m = msg('xmtp.org/remoteStaticAttachment:1.0', {
    url: 'https://files.example/abc', scheme: 'https://',
    contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n', filename: 'photo.jpg',
  });
  expect(describeMessage(m, { fromMe: true })).toEqual({
    kind: 'attachment', filename: 'photo.jpg', fromMe: true,
  });
});

test('an attachment with no filename still previews', () => {
  const m = msg('xmtp.org/remoteStaticAttachment:1.0', {
    url: 'https://files.example/abc', scheme: 'https://',
    contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n',
  });
  const d = describeMessage(m);
  expect(d).toEqual({ kind: 'attachment', filename: null, fromMe: false });
  expect(isPreviewable(d)).toBe(true);
});

test('an undecodable attachment falls back like any unknown type', () => {
  const m = msg('xmtp.org/remoteStaticAttachment:1.0', { url: 'ipfs://bafy' });
  expect(describeMessage(m)).toEqual({ kind: 'none' });
});
```

- [ ] **Step 10: Run them and confirm they fail**

Run: `npx jest src/describeMessage.test.ts -t attachment`
Expected: FAIL, received `{ kind: 'none' }`.

- [ ] **Step 11: Add the `attachment` description**

In `src/describeMessage.ts`:

```ts
import { decodeRemoteAttachment } from './attachmentContent';
```

Extend the union:

```ts
export type MessageDescription =
  | { kind: 'text'; text: string }
  | { kind: 'reaction'; emoji: string; fromMe: boolean }
  | { kind: 'attachment'; filename: string | null; fromMe: boolean }
  | { kind: 'card'; cardKind: string; preview: string | null; fallback: string }
  | { kind: 'none' };
```

In `describeMessage`, directly after the reaction block and before the card lookup:

```ts
  const attachment = decodeRemoteAttachment(m);
  if (attachment) {
    return { kind: 'attachment', filename: attachment.filename ?? null, fromMe: !!opts?.fromMe };
  }
```

In `isPreviewable`:

```ts
    case 'attachment': return true;
```

Add one sentence to the file's header comment: `An attachment describes by filename only; the host words it ("📎 photo.jpg", "You sent a file").`

- [ ] **Step 12: Run the full verification**

Run: `npm run typecheck && npm test`
Expected: both pass. If typecheck flags an exhaustive `switch` on `MessageDescription` elsewhere in `src/`, add the `attachment` case there with the same "describe by filename" behavior.

- [ ] **Step 13: Commit**

```bash
git add __mocks__/@xmtp/react-native-sdk.js src/attachmentContent.ts src/attachmentContent.test.ts src/client.ts src/client.test.ts src/describeMessage.ts src/describeMessage.test.ts
git commit -m "feat(attachments): decode and describe remote attachments"
```

---

### Task 2: Attachment config, upload and open

**Files:**
- Modify: `src/configure.ts` (add types + field on `XmtpChatConfig`)
- Create: `src/attachments.ts`
- Create: `src/attachments.test.ts`

**Interfaces:**
- Consumes: `getActiveXmtpClient()` from `src/client.ts`; `xmtpConfig()` from `src/configure.ts`.
- Produces:
  - `interface AttachmentUpload { encryptedFileUri: string; byteLength: number | null; contentDigest: string }`
  - `interface XmtpAttachmentsConfig { upload(file: AttachmentUpload): Promise<string>; download(url: string): Promise<string>; maxBytes?: number }`
  - `XmtpChatConfig.attachments?: XmtpAttachmentsConfig`
  - `interface LocalAttachmentFile { fileUri: string; mimeType: string; filename?: string }`
  - `DEFAULT_ATTACHMENT_MAX_BYTES = 25_000_000`
  - `class AttachmentTooLargeError extends Error { byteLength: number; maxBytes: number }`
  - `uploadAttachment(file: LocalAttachmentFile): Promise<RemoteAttachmentContent>`
  - `openAttachment(content: RemoteAttachmentContent): Promise<DecryptedLocalAttachment>`
  - `__resetAttachmentCache(): void` (test seam)

- [ ] **Step 1: Add the config types**

In `src/configure.ts`, above `export interface XmtpChatConfig`:

```ts
/** The encrypted file a host's `upload` stores. Every byte of it is ciphertext. */
export interface AttachmentUpload {
  /** file:// URI of the ciphertext, written by the SDK. Yours to delete after upload. */
  encryptedFileUri: string;
  /** Ciphertext size in bytes, or null when the SDK didn't report it. */
  byteLength: number | null;
  /** Hex SHA-256 of the ciphertext — stable and content-derived, so usable as an object key. */
  contentDigest: string;
}

/**
 * Where attachment ciphertext lives. The package encrypts before `upload` and
 * decrypts after `download`, so neither hook ever sees plaintext and the store
 * needs no access control of its own — but see the README's "Attachments"
 * section for what public ciphertext still reveals, and why IPFS differs.
 */
export interface XmtpAttachmentsConfig {
  /**
   * Store the ciphertext and resolve its URL. The URL must be `https://`,
   * permanent (a presigned GET expires and breaks old messages), readable
   * without auth headers, and CORS-open to GET — other XMTP clients, including
   * browser ones, fetch it with a bare request.
   */
  upload(file: AttachmentUpload): Promise<string>;
  /** Fetch `url` to a local file and resolve its file:// URI. */
  download(url: string): Promise<string>;
  /** Largest ciphertext `sendAttachment` accepts. Defaults to 25 000 000. */
  maxBytes?: number;
}
```

Add the field to `XmtpChatConfig`, after `clientCreateTimeoutMs`:

```ts
  /**
   * Storage for sending and opening attachments. Absent means attachments are
   * off: inbound ones still decode and describe, but sending or opening one
   * throws.
   */
  attachments?: XmtpAttachmentsConfig;
```

- [ ] **Step 2: Write the failing tests**

Create `src/attachments.test.ts`:

```ts
// Attachment I/O is the one path that hands data to a host hook, so the
// contract with those hooks is pinned here: ciphertext out, https in, the size
// limit enforced before anything leaves the device, and one download per file.
import { configureXmtpChat } from './configure';
import {
  AttachmentTooLargeError,
  __resetAttachmentCache,
  openAttachment,
  uploadAttachment,
} from './attachments';

const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => ({ encryptAttachment: mockEncrypt, decryptAttachment: mockDecrypt }),
}));

const metadata = { secret: 's', salt: 'l', nonce: 'n', contentDigest: 'digest-1', contentLength: '2048', filename: 'a.jpg' };
const upload = jest.fn();
const download = jest.fn();

function configure(maxBytes?: number) {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], attachments: { upload, download, maxBytes } });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetAttachmentCache();
  mockEncrypt.mockResolvedValue({ encryptedLocalFileUri: 'file:///tmp/enc', metadata });
  mockDecrypt.mockResolvedValue({ fileUri: 'file:///tmp/plain.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' });
  upload.mockResolvedValue('https://files.example/digest-1');
  download.mockResolvedValue('file:///tmp/downloaded');
  configure();
});

const file = { fileUri: 'file:///photos/a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' };

test('uploads the ciphertext and returns sendable content', async () => {
  const content = await uploadAttachment(file);
  expect(mockEncrypt).toHaveBeenCalledWith(file);
  expect(upload).toHaveBeenCalledWith({ encryptedFileUri: 'file:///tmp/enc', byteLength: 2048, contentDigest: 'digest-1' });
  expect(content).toEqual({ ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' });
});

test('rejects an oversized file before upload', async () => {
  configure(1000);
  await expect(uploadAttachment(file)).rejects.toBeInstanceOf(AttachmentTooLargeError);
  expect(upload).not.toHaveBeenCalled();
});

test('rejects an upload that resolves a non-https url', async () => {
  upload.mockResolvedValue('ipfs://bafy');
  await expect(uploadAttachment(file)).rejects.toThrow('https://');
});

test('throws when attachments are not configured', async () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await expect(uploadAttachment(file)).rejects.toThrow('attachments');
});

test('opening downloads, then decrypts with the message metadata', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  const opened = await openAttachment(content);
  expect(download).toHaveBeenCalledWith('https://files.example/digest-1');
  expect(mockDecrypt).toHaveBeenCalledWith({ encryptedLocalFileUri: 'file:///tmp/downloaded', metadata });
  expect(opened.fileUri).toBe('file:///tmp/plain.jpg');
});

test('concurrent and repeat opens download once', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  await Promise.all([openAttachment(content), openAttachment(content)]);
  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(1);
});

test('a failed open is not cached, so a retry downloads again', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  download.mockRejectedValueOnce(new Error('offline'));
  await expect(openAttachment(content)).rejects.toThrow('offline');
  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(2);
});

test('the sender opens their own upload without downloading it', async () => {
  const content = await uploadAttachment(file);
  const opened = await openAttachment(content);
  expect(download).not.toHaveBeenCalled();
  expect(opened.fileUri).toBe('file:///photos/a.jpg');
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx jest src/attachments.test.ts`
Expected: FAIL with `Cannot find module './attachments'`.

- [ ] **Step 4: Implement `src/attachments.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx jest src/attachments.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full verification**

Run: `npm run typecheck && npm test`
Expected: both pass. If typecheck rejects `client.encryptAttachment(file)` because `Client<any>` doesn't expose it, confirm the method exists at `node_modules/@xmtp/react-native-sdk/src/lib/Client.ts:1009` and check the return type of `getActiveXmtpClient()` in `src/client.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/configure.ts src/attachments.ts src/attachments.test.ts
git commit -m "feat(attachments): encrypt-upload and download-decrypt through host hooks"
```

---

### Task 3: Delivery state for attachment messages

**Files:**
- Modify: `src/deliveryState.ts`
- Modify: `src/deliveryState.test.ts`

**Interfaces:**
- Consumes: `LocalAttachmentFile` from `src/attachments.ts` (type-only import); `RemoteAttachmentContent` from the SDK (type-only).
- Produces:
  - `DeliveryTrackedMessage` gains `attachment?: { contentDigest: string }`
  - `interface LocalAttachmentMessage { id; senderInboxId; sentNs; fromMe: true; kind: 'attachment'; localFile: LocalAttachmentFile; attachment?: RemoteAttachmentContent; delivery: MessageDelivery }`
  - `makeLocalAttachmentMessage(file: LocalAttachmentFile, senderInboxId: InboxId | null, nowMs?: number): LocalAttachmentMessage`
  - `attachUploaded<M extends DeliveryTrackedMessage>(prev: M[], localId: string, content: RemoteAttachmentContent): M[]`
  - `isOptimistic`, `setDelivery`, `reconcileSent`, `mergeStreamed`, `markReadUpTo` all treat `kind: 'attachment'` like `kind: 'text'`.

- [ ] **Step 1: Write the failing tests**

Append to `src/deliveryState.test.ts` (reuse its existing imports; add the new names to the import from `./deliveryState`):

```ts
describe('attachments', () => {
  const file = { fileUri: 'file:///a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' };
  const content = {
    url: 'https://files.example/d', scheme: 'https://' as const,
    contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n', filename: 'a.jpg',
  };

  test('a local attachment starts pending and optimistic', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    expect(local).toMatchObject({ kind: 'attachment', localFile: file, delivery: 'pending', fromMe: true, sentNs: 1000 * 1e6 });
    expect(isOptimistic(local)).toBe(true);
  });

  test('upload content lands on the local copy only', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    const next = attachUploaded([local], local.id, content);
    expect(next[0]).toMatchObject({ attachment: content, delivery: 'pending' });
  });

  test('fails, acks and reads like a text message', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    expect(setDelivery([local], local.id, 'failed')[0].delivery).toBe('failed');
    const acked = reconcileSent([local], local.id, 'net-1');
    expect(acked[0]).toMatchObject({ id: 'net-1', delivery: 'sent' });
    expect(markReadUpTo(acked, 2000 * 1e6)[0].delivery).toBe('read');
  });

  test('a stream echo that beats the ack replaces the local copy by digest', () => {
    const localCopy = { ...makeLocalAttachmentMessage(file, 'me' as any, 1000), attachment: content };
    const echo = { id: 'net-1', senderInboxId: 'me', sentNs: 1001 * 1e6, fromMe: true, kind: 'attachment', attachment: content };
    const merged = mergeStreamed([localCopy] as any[], echo as any);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(echo);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest src/deliveryState.test.ts -t attachments`
Expected: FAIL, `makeLocalAttachmentMessage is not a function`.

- [ ] **Step 3: Implement**

In `src/deliveryState.ts`:

1. Add type imports:

```ts
import type { InboxId, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import type { LocalAttachmentFile } from './attachments';
```

2. Update the header comment's second paragraph to: `Plain-text and attachment composer sends are optimistic — custom-codec sends ...` (rest unchanged).

3. Extend `DeliveryTrackedMessage`:

```ts
  text?: string;
  /** Present on an attachment bubble once its upload has finished. */
  attachment?: { contentDigest: string };
```

4. Add after `LocalTextMessage`:

```ts
/** A local optimistic attachment bubble. `attachment` appears once the upload finishes. */
export interface LocalAttachmentMessage {
  id: string;
  senderInboxId: InboxId;
  sentNs: number;
  fromMe: true;
  kind: 'attachment';
  /** The sender's own file, so the bubble renders before any upload. */
  localFile: LocalAttachmentFile;
  attachment?: RemoteAttachmentContent;
  delivery: MessageDelivery;
}

/** Text and attachment bubbles carry delivery state; cards never do. */
function tracksDelivery(m: DeliveryTrackedMessage): boolean {
  return m.kind === 'text' || m.kind === 'attachment';
}
```

5. Replace `m.kind === 'text'` with `tracksDelivery(m)` in `isOptimistic`, `setDelivery`, `reconcileSent` and `markReadUpTo` (in `markReadUpTo` the condition becomes `!tracksDelivery(m) || !m.fromMe || ...`). Update the `markReadUpTo` comment's "Only my own text bubbles are touched" to "Only my own text and attachment bubbles are touched".

6. Add after `makeLocalTextMessage`:

```ts
export function makeLocalAttachmentMessage(
  file: LocalAttachmentFile,
  senderInboxId: InboxId | null,
  nowMs: number = Date.now(),
): LocalAttachmentMessage {
  return {
    id: nextLocalId(),
    senderInboxId: (senderInboxId ?? '') as InboxId,
    sentNs: nowMs * 1e6,
    fromMe: true,
    kind: 'attachment',
    localFile: file,
    delivery: 'pending',
  };
}

/**
 * Record a finished upload on the local copy. A retry after a failed send then
 * re-sends this content instead of uploading the file a second time, and the
 * stream echo can be matched to this bubble by digest.
 */
export function attachUploaded<M extends DeliveryTrackedMessage>(
  prev: M[],
  localId: string,
  content: RemoteAttachmentContent,
): M[] {
  return prev.map((m) =>
    m.id === localId && m.kind === 'attachment' ? ({ ...m, attachment: content } as M) : m,
  );
}
```

7. In `mergeStreamed`, after the existing `if (next.kind === 'text' && next.fromMe) { ... }` block:

```ts
  if (next.kind === 'attachment' && next.fromMe && next.attachment) {
    const digest = next.attachment.contentDigest;
    const inFlight = prev.findIndex(
      (m) =>
        m.kind === 'attachment' &&
        (m.delivery === 'pending' || m.delivery === 'sent') &&
        m.attachment?.contentDigest === digest,
    );
    if (inFlight >= 0) {
      const copy = [...prev];
      copy[inFlight] = next;
      return copy.sort(byNewest);
    }
  }
```

Update the `mergeStreamed` doc comment's last sentence to: `A same-text echo of an in-flight local text, or a same-digest echo of an in-flight attachment (stream beat the ack, ids not linked yet), also replaces it, so a fast echo never double-bubbles.`

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest src/deliveryState.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Run the full verification**

Run: `npm run typecheck && npm test`
Expected: both pass. A circular type import (`deliveryState` → `attachments` → `client`) is type-only and erased by Babel; if typecheck still complains, move `LocalAttachmentFile` into `src/attachmentContent.ts` and re-export it from `src/attachments.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/deliveryState.ts src/deliveryState.test.ts
git commit -m "feat(attachments): optimistic delivery state for attachment bubbles"
```

---

### Task 4: `sendAttachment` and attachment bubbles in `useConversation`

**Files:**
- Modify: `src/useConversation.ts`

No hook-level test exists for `useConversation` today, and building one means mocking the DM, stream and client lifecycle. The logic this task wires together is already unit-tested in Tasks 1–3. This task is verified by typecheck, the full suite, and the device check in Task 7.

**Interfaces:**
- Consumes: `decodeRemoteAttachment`, `isRemoteAttachment` (Task 1); `uploadAttachment`, `AttachmentTooLargeError`, `LocalAttachmentFile` (Task 2); `makeLocalAttachmentMessage`, `attachUploaded` (Task 3).
- Produces:
  - `ChatMessage` gains the branch `ChatMessageBase & { kind: 'attachment'; attachment?: RemoteAttachmentContent; localFile?: LocalAttachmentFile; delivery?: MessageDelivery }`
  - `UseConversationResult.sendAttachment: (file: LocalAttachmentFile) => Promise<void>`
  - `retryMessage` retries a failed attachment.

- [ ] **Step 1: Add imports**

```ts
import type { RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import { decodeRemoteAttachment, isRemoteAttachment } from './attachmentContent';
import { AttachmentTooLargeError, uploadAttachment, type LocalAttachmentFile } from './attachments';
```

Add `makeLocalAttachmentMessage` and `attachUploaded` to the `./deliveryState` import.

(If the file already imports types from `@xmtp/react-native-sdk` in one statement, add `type RemoteAttachmentContent` there instead of a second import.)

- [ ] **Step 2: Extend `ChatMessage`**

After the text branch:

```ts
  // An attachment from any XMTP client. `attachment` is the wire content —
  // absent only on our own local copy while its upload runs — and `localFile`
  // is present only on that local copy, so the bubble renders the picked file
  // immediately. Render the file through `useAttachment(message.attachment)`.
  | (ChatMessageBase & {
      kind: 'attachment';
      attachment?: RemoteAttachmentContent;
      localFile?: LocalAttachmentFile;
      delivery?: MessageDelivery;
    })
```

- [ ] **Step 3: Decode attachments in `toChatMessage`**

After the `if (isReply(m)) { ... }` block, before the card lookup:

```ts
  // A remote attachment is a first-class bubble. One that won't decode (a URL
  // scheme we can't fetch, missing key material) keeps its codec fallback so
  // the thread shows that something arrived.
  if (isRemoteAttachment(m)) {
    const attachment = decodeRemoteAttachment(m);
    if (attachment) return { ...base, kind: 'attachment', attachment };
    return m.fallback ? { ...base, kind: 'text', text: m.fallback } : null;
  }
```

- [ ] **Step 4: Extract DM + context-card preparation from `deliverText`**

Add above `deliverText`:

```ts
  /**
   * The thread a send goes to: created on first send (the only place a DM is
   * materialized, then attached so the stream echoes our send back), with this
   * chat's context card posted first when it differs from the thread's most
   * recent card of that kind. The key advances only on success, so a retry
   * re-sends the card.
   */
  const prepareSend = useCallback(async (): Promise<Dm<any>> => {
    let dm = dmRef.current;
    if (!dm) {
      const client = getActiveXmtpClient();
      if (!client) throw new Error('Messaging client unavailable');
      const identity = new PublicIdentity(counterpartyAddress.toLowerCase(), 'ETHEREUM');
      dm = await client.conversations.findOrCreateDmWithIdentity(identity);
      await attachDm(dm);
    }
    if (context && context.key(context.payload) !== lastCardKeyRef.current) {
      await dm.send(context.payload as any, { contentType: context.cardType.codec.contentType });
      lastCardKeyRef.current = context.key(context.payload);
    }
    return dm;
  }, [counterpartyAddress, attachDm, context]);
```

Replace `deliverText`'s body with:

```ts
  const deliverText = useCallback(
    async (localId: string, text: string, replyToId?: string) => {
      try {
        const dm = await prepareSend();
        // A reply rides XMTP's native reply type, which nests the text under
        // the id it answers; a plain send is just the string.
        const sentId = replyToId
          ? await dm.send({ reply: { reference: replyToId, content: { text } } } as any)
          : await dm.send(text);
        setMessages((prev) => reconcileSent(prev, localId, sentId));
      } catch (err: any) {
        console.warn('[xmtp] send failed', err?.message ?? err);
        setMessages((prev) => setDelivery(prev, localId, 'failed'));
      }
    },
    [prepareSend],
  );
```

Trim `deliverText`'s doc comment to: `Deliver an already-appended local text message (as a quoted reply when replyToId is given). Any throw flips the local bubble to failed (retryable) instead of propagating — the bubble is the failure surface.`

- [ ] **Step 5: Add `deliverAttachment` and `sendAttachment`**

After `deliverText`:

```ts
  /**
   * Upload (unless a previous attempt already did), then send. The upload runs
   * before the DM is prepared, so a file that can't be stored never
   * materializes an empty thread. An oversized file removes its bubble and
   * rejects: unlike a network failure, retrying cannot fix it.
   */
  const deliverAttachment = useCallback(
    async (localId: string, file: LocalAttachmentFile, uploaded?: RemoteAttachmentContent) => {
      try {
        let content = uploaded;
        if (!content) {
          content = await uploadAttachment(file);
          const done = content;
          setMessages((prev) => attachUploaded(prev, localId, done));
        }
        const dm = await prepareSend();
        const sentId = await dm.send({ remoteAttachment: content } as any);
        setMessages((prev) => reconcileSent(prev, localId, sentId));
      } catch (err: any) {
        if (err instanceof AttachmentTooLargeError) {
          setMessages((prev) => discardMessage(prev, localId));
          throw err;
        }
        console.warn('[xmtp] attachment send failed', err?.message ?? err);
        setMessages((prev) => setDelivery(prev, localId, 'failed'));
      }
    },
    [prepareSend],
  );

  const sendAttachment = useCallback(
    async (file: LocalAttachmentFile) => {
      const local = makeLocalAttachmentMessage(file, myInboxIdRef.current);
      setMessages((prev) => [local, ...prev]);
      await deliverAttachment(local.id, file);
    },
    [deliverAttachment],
  );
```

- [ ] **Step 6: Retry failed attachments**

Replace `retryMessage`'s body:

```ts
  const retryMessage = useCallback(
    async (message: M) => {
      // Only a local optimistic bubble carries `delivery` — the caller's `M`
      // only guarantees the minimal bound, so narrow through the internal wide
      // shape rather than widening the public bound.
      const failed = message as unknown as AnyChatMessage;
      if (failed.kind === 'text' && failed.delivery === 'failed') {
        setMessages((prev) => setDelivery(prev, failed.id, 'pending'));
        await deliverText(failed.id, failed.text, failed.replyToId);
        return;
      }
      if (failed.kind === 'attachment' && failed.delivery === 'failed' && failed.localFile) {
        setMessages((prev) => setDelivery(prev, failed.id, 'pending'));
        await deliverAttachment(failed.id, failed.localFile, failed.attachment);
      }
    },
    [deliverText, deliverAttachment],
  );
```

- [ ] **Step 7: Expose it**

Add to `UseConversationResult`, after `send`:

```ts
  /**
   * Optimistic attachment send, same contract as `send`: a local `pending`
   * bubble (carrying `localFile`) appears immediately and a delivery failure
   * surfaces on it. The one rejection is `AttachmentTooLargeError`, which also
   * removes the bubble. Requires `attachments` in `configureXmtpChat`.
   */
  sendAttachment: (file: LocalAttachmentFile) => Promise<void>;
```

Add `sendAttachment,` to the returned object after `send,`.

- [ ] **Step 8: Run the full verification**

Run: `npm run typecheck && npm test`
Expected: both pass. If `failed.localFile` or `failed.attachment` doesn't narrow after `failed.kind === 'attachment'`, the new branch is missing from `ChatMessage` (Step 2) — `AnyChatMessage` derives from it.

- [ ] **Step 9: Commit**

```bash
git add src/useConversation.ts
git commit -m "feat(attachments): sendAttachment and attachment bubbles in useConversation"
```

---

### Task 5: `useAttachment` render hook

**Files:**
- Create: `src/useAttachment.ts`
- Create: `src/useAttachment.test.ts`

**Interfaces:**
- Consumes: `openAttachment` (Task 2).
- Produces:
  - `type AttachmentLoadState = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; file: DecryptedLocalAttachment } | { state: 'failed'; error: string }`
  - `useAttachment(content: RemoteAttachmentContent | undefined, opts?: { autoLoad?: boolean }): { status: AttachmentLoadState; load: () => Promise<void> }`

- [ ] **Step 1: Write the failing tests**

Create `src/useAttachment.test.ts`:

```ts
// A bubble renders from this hook, so its states are the bubble's states: a
// spinner while the file comes down, the file when it's ready, and a retry that
// works after a failure. Large files must be able to wait for a tap.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useAttachment } from './useAttachment';

const mockOpen = jest.fn();
jest.mock('./attachments', () => ({ openAttachment: (c: unknown) => mockOpen(c) }));

const content = {
  url: 'https://files.example/d', scheme: 'https://' as const,
  contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n',
};
const file = { fileUri: 'file:///plain.jpg', mimeType: 'image/jpeg' };

beforeEach(() => jest.clearAllMocks());

test('loads on mount and reports the file', async () => {
  mockOpen.mockResolvedValue(file);
  const { result } = renderHook(() => useAttachment(content));
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file }));
});

test('autoLoad false waits for load()', async () => {
  mockOpen.mockResolvedValue(file);
  const { result } = renderHook(() => useAttachment(content, { autoLoad: false }));
  expect(result.current.status).toEqual({ state: 'idle' });
  expect(mockOpen).not.toHaveBeenCalled();
  await act(async () => { await result.current.load(); });
  expect(result.current.status).toEqual({ state: 'ready', file });
});

test('a failure is reported and load() retries it', async () => {
  mockOpen.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(file);
  const { result } = renderHook(() => useAttachment(content));
  await waitFor(() => expect(result.current.status).toEqual({ state: 'failed', error: 'offline' }));
  await act(async () => { await result.current.load(); });
  expect(result.current.status).toEqual({ state: 'ready', file });
});

test('no content stays idle', () => {
  const { result } = renderHook(() => useAttachment(undefined));
  expect(result.current.status).toEqual({ state: 'idle' });
  expect(mockOpen).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest src/useAttachment.test.ts`
Expected: FAIL with `Cannot find module './useAttachment'`.

- [ ] **Step 3: Implement `src/useAttachment.ts`**

```ts
/**
 * Load state for one attachment bubble.
 *
 * Downloads and decrypts on mount by default. Pass `autoLoad: false` for types
 * a user should opt into (video, large documents) and call `load()` from a tap.
 * `load()` is also the retry after a failure. Results are cached per file for
 * the session (see attachments.ts), so a bubble scrolling back into view does
 * not download again.
 *
 * Our own local copy has no `attachment` until its upload finishes; render
 * `message.localFile` for it instead of calling this with undefined.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecryptedLocalAttachment, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import { openAttachment } from './attachments';

export type AttachmentLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; file: DecryptedLocalAttachment }
  | { state: 'failed'; error: string };

export function useAttachment(
  content: RemoteAttachmentContent | undefined,
  opts: { autoLoad?: boolean } = {},
): { status: AttachmentLoadState; load: () => Promise<void> } {
  const autoLoad = opts.autoLoad ?? true;
  const [status, setStatus] = useState<AttachmentLoadState>({ state: 'idle' });
  const contentRef = useRef(content);
  contentRef.current = content;
  const digest = content?.contentDigest;

  const load = useCallback(async () => {
    const target = contentRef.current;
    if (!target) return;
    // A recycled list cell can switch content mid-download; only the file the
    // cell still shows may land in its state.
    const current = () => contentRef.current?.contentDigest === target.contentDigest;
    setStatus({ state: 'loading' });
    try {
      const file = await openAttachment(target);
      if (current()) setStatus({ state: 'ready', file });
    } catch (err: any) {
      if (current()) setStatus({ state: 'failed', error: err?.message ?? String(err) });
    }
  }, []);

  useEffect(() => {
    setStatus({ state: 'idle' });
    if (digest && autoLoad) void load();
  }, [digest, autoLoad, load]);

  return { status, load };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest src/useAttachment.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full verification**

Run: `npm run typecheck && npm test`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/useAttachment.ts src/useAttachment.test.ts
git commit -m "feat(attachments): useAttachment render hook"
```

---

### Task 6: Uploader helpers, exports, README and CHANGELOG

**Files:**
- Create: `src/attachmentUploaders.ts`
- Create: `src/attachmentUploaders.test.ts`
- Modify: `src/index.ts`
- Modify: `README.md` (Scope paragraph ~line 27, "Compared to a hosted chat API" ~lines 39-50, new section after "Custom content types" ~line 261, Status ~lines 347-360)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**
- Consumes: `AttachmentUpload`, `XmtpAttachmentsConfig` (Task 2).
- Produces:
  - `readLocalFile(fileUri: string): Promise<Blob>`
  - `interface PresignedPut { uploadUrl: string; publicUrl: string; headers?: Record<string, string> }`
  - `createPresignedPutUploader(presign: (file: AttachmentUpload) => Promise<PresignedPut>, opts?: { readFile?: (fileUri: string) => Promise<Blob> }): XmtpAttachmentsConfig['upload']`
  - `createIpfsUploader(opts: { pin: (file: AttachmentUpload) => Promise<string>; gateway: string }): XmtpAttachmentsConfig['upload']`

- [ ] **Step 1: Write the failing tests**

Create `src/attachmentUploaders.test.ts`:

```ts
// The shipped uploaders are where a host's storage meets the URL rules other
// XMTP clients depend on: a presigned PUT must actually succeed before its
// public URL is trusted, and an IPFS upload must become an https gateway URL.
import { createIpfsUploader, createPresignedPutUploader } from './attachmentUploaders';

const file = { encryptedFileUri: 'file:///tmp/enc', byteLength: 10, contentDigest: 'abc' };
const blob = new Blob(['cipher']);
const readFile = jest.fn().mockResolvedValue(blob);
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = mockFetch;
});

test('presigned PUT uploads the ciphertext and returns the public url', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  const presign = jest.fn().mockResolvedValue({
    uploadUrl: 'https://bucket.example/abc?sig=1',
    publicUrl: 'https://cdn.example/abc',
    headers: { 'x-amz-acl': 'public-read' },
  });
  const upload = createPresignedPutUploader(presign, { readFile });
  await expect(upload(file)).resolves.toBe('https://cdn.example/abc');
  expect(presign).toHaveBeenCalledWith(file);
  expect(readFile).toHaveBeenCalledWith('file:///tmp/enc');
  expect(mockFetch).toHaveBeenCalledWith('https://bucket.example/abc?sig=1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-amz-acl': 'public-read' },
    body: blob,
  });
});

test('presigned PUT throws on a non-2xx response', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 403 });
  const presign = jest.fn().mockResolvedValue({ uploadUrl: 'https://b/x', publicUrl: 'https://c/x' });
  await expect(createPresignedPutUploader(presign, { readFile })(file)).rejects.toThrow('HTTP 403');
});

test('IPFS builds an https gateway url from the pinned CID', async () => {
  const pin = jest.fn().mockResolvedValue('bafyCID');
  const upload = createIpfsUploader({ pin, gateway: 'https://acme.mypinata.cloud/' });
  await expect(upload(file)).resolves.toBe('https://acme.mypinata.cloud/ipfs/bafyCID');
  expect(pin).toHaveBeenCalledWith(file);
});

test('IPFS refuses a non-https gateway at setup', () => {
  expect(() => createIpfsUploader({ pin: jest.fn(), gateway: 'ipfs://' })).toThrow('https://');
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest src/attachmentUploaders.test.ts`
Expected: FAIL with `Cannot find module './attachmentUploaders'`.

- [ ] **Step 3: Implement `src/attachmentUploaders.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest src/attachmentUploaders.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Export everything**

In `src/index.ts`:

After the `configure` type export line, change it to:

```ts
export type { XmtpChatConfig, XmtpPlatform, XmtpAttachmentsConfig, AttachmentUpload } from './configure';
```

After the `describeMessage` exports, add:

```ts
export { isRemoteAttachment, decodeRemoteAttachment } from './attachmentContent';
export {
  uploadAttachment, openAttachment, AttachmentTooLargeError, DEFAULT_ATTACHMENT_MAX_BYTES,
} from './attachments';
export type { LocalAttachmentFile } from './attachments';
export { useAttachment } from './useAttachment';
export type { AttachmentLoadState } from './useAttachment';
export { createPresignedPutUploader, createIpfsUploader, readLocalFile } from './attachmentUploaders';
export type { PresignedPut } from './attachmentUploaders';
```

Add `makeLocalAttachmentMessage, attachUploaded,` to the `./deliveryState` export list.

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 6: Update README claims that attachments are missing**

1. Scope paragraph ("What is here: ..."): after `consent-based blocking,` insert `attachments over host-supplied storage,`.
2. "Compared to a hosted chat API": change `threads and attachments` to `and threads`. Replace the sentence starting `Two costs this does not remove. **Attachments are unimplemented here** — ...` through `...rather than in the protocol.` with:

```md
Two costs this does not remove. **Attachments need storage you run** — the
package encrypts them and speaks XMTP's standard format, but the ciphertext has
to live somewhere, and you pay for that bucket.
```

3. Status: change `and attachments are unimplemented.` to `.` (so the sentence ends `(see Scope).`). Update the suite/test counts in the first Status paragraph to the numbers `npm test` prints now.

- [ ] **Step 7: Add the README "Attachments" section**

Insert after the "Custom content types" section (before `### Background push`):

````md
### Attachments

Attachments use XMTP's standard remote attachment, so any XMTP client can open
the ones you send and you can open theirs. The file is encrypted on the device;
you supply where the ciphertext is stored.

```ts
import { configureXmtpChat, createPresignedPutUploader } from 'xmtp-chat-rn';
import { File, Paths } from 'expo-file-system';

configureXmtpChat({
  // ...
  attachments: {
    // Your server returns a signed PUT for the object key; never ship bucket
    // credentials in the app.
    upload: createPresignedPutUploader((file) =>
      api.post('/attachments/presign', { key: file.contentDigest, bytes: file.byteLength }),
    ),
    download: async (url) => (await File.downloadFileAsync(url, Paths.cache, { idempotent: true })).uri,
    maxBytes: 25_000_000, // the default
  },
});
```

The `download` line targets the `expo-file-system` API that ships with Expo 55;
any function that writes the URL to a local file and returns its `file://` URI
works.

Send from the thread hook, and render with `useAttachment`:

```tsx
const { sendAttachment } = useConversation(peerAddress);
await sendAttachment({ fileUri, mimeType: 'image/jpeg', filename: 'photo.jpg' });

function AttachmentBubble({ message }) {
  const { status, load } = useAttachment(message.attachment);
  const uri = message.localFile?.fileUri ?? (status.state === 'ready' ? status.file.fileUri : null);
  if (uri) return <Image source={{ uri }} />;
  if (status.state === 'failed') return <Retry onPress={load} />;
  return <Spinner />;
}
```

`sendAttachment` behaves like `send`: a pending bubble at once, `failed` with
tap-to-retry on a network error (a retry reuses the finished upload). The one
rejection is `AttachmentTooLargeError`, which also removes the bubble.

**Your storage URL must be:**

1. `https://` — the SDK accepts no other scheme, so IPFS goes through a gateway.
2. Permanent — a presigned GET expires within 7 days and breaks old messages.
3. Readable without auth headers — other clients send a bare GET.
4. CORS-open to GET from any origin — browser clients such as xmtp.chat cannot
   fetch it otherwise.

#### What storage can see

The stored file is ciphertext. Each file gets its own random key (AES-256-GCM),
and that key travels only inside the XMTP message, which MLS encrypts to the
conversation. So the storage provider, and anyone who finds the URL, can
download the file but not read it.

Public ciphertext still reveals the file's size, when it was uploaded, and
whatever your storage account and the uploader's IP address tie it to. The
filename and type are not exposed; they travel inside the encrypted message.

#### S3/R2 or IPFS

**S3 or R2 (recommended).** Deleting the object revokes access for everyone,
even if a message key later leaks from a compromised device. R2 charges no
egress, which matters because every recipient downloads every file.

**IPFS (opt-in).** Use `createIpfsUploader({ pin, gateway })`, where `pin` stores
the ciphertext through your server and resolves the CID, and `gateway` is your
dedicated `https://` gateway (public gateways throttle). Understand the trade
first: **an IPFS file cannot be reliably deleted.** Unpinning does not remove
copies other nodes and gateways have cached. The file is therefore only as
private as its key, for as long as any copy exists — if a recipient's device or
chat database leaks years later, the file is readable then. MLS forward secrecy
does not help, because it protects message keys, not a file already public on
IPFS.

**Not supported yet:** several files in one message (XMTP's multi remote
attachment) and rendering inline static attachments — both decode, and show
their text fallback.
````

- [ ] **Step 8: Update CHANGELOG**

Under `## [Unreleased]`:

```md
### Added
- Attachments over XMTP's standard remote attachment content type.
  `configureXmtpChat({ attachments: { upload, download, maxBytes } })` supplies
  storage; the package encrypts before upload and decrypts after download.
  `useConversation` gains `sendAttachment` (optimistic, retryable) and an
  `attachment` message kind; `useAttachment` loads one for rendering;
  `describeMessage` returns `{ kind: 'attachment', filename, fromMe }`.
- `createPresignedPutUploader` (S3, R2, GCS, MinIO) and `createIpfsUploader`
  (pinning service + https gateway), plus `uploadAttachment`, `openAttachment`,
  `AttachmentTooLargeError` and `DEFAULT_ATTACHMENT_MAX_BYTES`.
- The remote and static attachment codecs are registered on every client, so
  other clients' attachments decode even with `attachments` unset.

### Changed
- `attachment` is now a reserved `ChatMessage` kind. A card registered with
  `kind: 'attachment'` collides with it and must be renamed.
- `MessageDescription` has a new `attachment` member; an exhaustive `switch` over
  it needs the new case.
```

- [ ] **Step 9: Run the full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/attachmentUploaders.ts src/attachmentUploaders.test.ts src/index.ts README.md CHANGELOG.md
git commit -m "feat(attachments): storage uploaders, exports and docs"
```

---

### Task 7: Device and interop check (manual)

Unit tests mock the SDK and `fetch`, so three things are unverified until this runs: React Native's `fetch` reading a `file://` URI as a Blob, the native encrypt/decrypt round trip, and other clients opening what we send. About 30–45 minutes with a bucket already set up.

**Files:**
- No committed code unless a check fails. If `readLocalFile` fails on a platform, change its default and the README note in one commit.

- [ ] **Step 1: Prepare a test bucket**

Create an R2 (or S3) bucket with public read on a custom domain or r2.dev URL and this CORS rule:

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET"], "AllowedHeaders": ["*"] }]
```

For presigning during the test, a local script is enough (`@aws-sdk/s3-request-presigner` with R2's S3 endpoint) that the example app calls on the LAN. Do not commit credentials or the script.

- [ ] **Step 2: Wire the example app locally**

In `example/`, add `attachments` to its `configureXmtpChat` call, using the presign script and the Task 6 README `download`. Add a button that sends a bundled test image (copy an asset to `Paths.cache` so it has a `file://` URI). Do not commit these example changes unless asked; they need a live bucket.

- [ ] **Step 3: Run the checks on Android and iOS**

For each platform, confirm and note the result:

1. Send an image: the bubble shows at once, then goes `sent`. If upload fails with a Blob or `file://` error, `readLocalFile` doesn't work there.
2. The object in the bucket is not a valid image when downloaded directly (it's ciphertext).
3. A second device or account receives it, `useAttachment` goes `ready`, and the image renders.
4. Airplane mode during send → `failed`; retry after reconnecting → `sent`, with only one object in the bucket.
5. Set `maxBytes: 1000` → `sendAttachment` rejects with `AttachmentTooLargeError` and no bubble remains.

- [ ] **Step 4: Check interop**

1. Open the conversation in xmtp.chat (browser, same `env`) as the recipient. The image should display. If it doesn't, check the browser console for a CORS error first.
2. Send an image from xmtp.chat to the app. It should render in the app.
3. If Convos or Base app is available on the same network, repeat step 1 and note how each displays it.

- [ ] **Step 5: Record results**

Add a short "Attachments interop" line to the README Status section listing the platforms and clients checked and the date, then:

```bash
git add README.md
git commit -m "docs(attachments): record device and interop check"
```
