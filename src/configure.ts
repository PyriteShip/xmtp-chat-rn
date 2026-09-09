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
   * Gates the on-sign-in orphaned-installation prune (see client.ts). The host
   * decides what "dev" means for this build rather than this package reading
   * `__DEV__` itself.
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
