/**
 * Host-supplied configuration for the XMTP chat layer.
 *
 * This package has no app config or native modules of its own: the network,
 * the enabled flag, the card registry, and — on iOS — the App Group platform
 * hooks all arrive through `configureXmtpChat`, called once at the host's
 * startup. Every other module in this package reads `xmtpConfig()` rather
 * than importing host code directly, which is what keeps the package portable
 * to `packages/xmtp-chat-rn`.
 */

import type { CardType } from './cardRegistry';

/** The encrypted file a host's `upload` stores. Every byte of it is ciphertext. */
export interface AttachmentUpload {
  /** file:// URI of the ciphertext, written by the SDK. Yours to delete after upload. */
  encryptedFileUri: string;
  /**
   * The native SDK's reported size, or null when it didn't report one. This
   * is the PLAINTEXT attachment's byte length, not the ciphertext's — the
   * ciphertext at `encryptedFileUri` is somewhat larger (the encoded-content
   * wrapper plus the GCM auth tag). Treat this as approximately the stored
   * size; a presign server must not sign an exact `Content-Length` computed
   * from it, since the real upload will differ.
   */
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
  /**
   * Largest attachment `sendAttachment` accepts. Defaults to 25 000 000.
   *
   * Whether this is a real memory guard or just a backstop depends on the
   * caller: pass `byteLength` on the `LocalAttachmentFile` (the plaintext
   * size a picker like `expo-image-picker` reports as `fileSize`) and an
   * oversized pick is rejected before native encryption ever reads it into
   * memory. Without it, the only check left is against the native SDK's
   * reported (plaintext) size — see `AttachmentUpload.byteLength` — which
   * runs AFTER encryption, by which point the whole file has already been
   * read into memory. So a host that cares about large-file memory pressure
   * should supply `byteLength` rather than relying on this option alone.
   */
  maxBytes?: number;
}

/**
 * iOS App Group hooks the Notification Service Extension shares with the app.
 * All optional: an absent `platform` (or an absent individual hook) must behave
 * exactly like today's Android path — a null db directory and a silent no-op
 * mirror — never a crash on an undefined call.
 */
export interface XmtpPlatform {
  /** App Group container path for the XMTP dbDirectory (iOS only). */
  dbDirectory?(): string | null;
  /** Mirror a value into the App Group shared store the NSE reads. */
  setSharedItem?(key: string, value: string): void;
  /** One-time copy of the XMTP db into the App Group container. */
  migrateDbIfNeeded?(): void;
}

export interface XmtpChatConfig {
  env: 'dev' | 'production' | 'local';
  enabled: boolean;
  cards: readonly CardType<any, any, string>[];
  platform?: XmtpPlatform;
  /**
   * Gates the at-cap installation recovery (see client.ts): when `Client.create`
   * fails because the inbox holds XMTP's ten installations, the package revokes
   * the oldest one, then retries create once. That revocation needs a wallet
   * signature, and the freed slot may belong to this wallet on another physical
   * device, so it is a dev-build affordance for emulator reinstall churn, not a
   * production default. It is the only revocation this package performs — a
   * sign-in that succeeds never revokes anything, whatever this flag says. The
   * host decides what "dev" means for this build rather than this package
   * reading `__DEV__` itself.
   */
  devInstallationPrune?: boolean;
  /**
   * Send a read receipt when the user reads a counterparty's message.
   *
   * Off unless the host opts in. Telling someone when you read their message is
   * a product decision with a privacy cost, and it is not reversible per
   * message once sent — so the default is the quiet one. Receiving and
   * rendering a counterparty's receipts is unaffected by this flag; it gates
   * only what we put on the wire.
   */
  readReceipts?: boolean;
  /**
   * Milliseconds a client creation attempt may run before it is abandoned.
   * Defaults to 60 000 — creation can wait on a wallet signature. `null` (or
   * any non-positive value) disables the bound.
   *
   * Creation is single-flighted per address, so without a bound a create that
   * hangs is handed to every later caller and a retry never starts. At the
   * deadline the attempt rejects with `XmtpClientCreateTimeoutError`, status
   * turns `failed`, and the next call starts a fresh attempt.
   */
  clientCreateTimeoutMs?: number | null;
  /**
   * Storage for sending and opening attachments. Absent means attachments are
   * off: inbound ones still decode and describe, but sending or opening one
   * throws.
   */
  attachments?: XmtpAttachmentsConfig;
}

let config: XmtpChatConfig | null = null;

/** Call once at app startup, before anything in this package is used. */
export function configureXmtpChat(next: XmtpChatConfig): void {
  config = next;
}

/**
 * The active configuration. Throws rather than falling back to a default: an
 * unconfigured client would register against the wrong XMTP network (`dev` and
 * `production` are disjoint) and build an inbox nobody can reach — a loud
 * failure at first use beats that silent, confusing one.
 */
export function xmtpConfig(): XmtpChatConfig {
  if (!config) {
    throw new Error('configureXmtpChat() must be called before using XMTP chat');
  }
  return config;
}
