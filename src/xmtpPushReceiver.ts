import type { Client, DecodedMessage, ConversationTopic } from '@xmtp/react-native-sdk';

/**
 * Decrypts a pushed XMTP envelope so a notification can name the sender and
 * preview the message, instead of showing a generic prompt.
 *
 * The push itself carries ciphertext, so the only way to a real preview is to
 * open the MLS database and process the envelope. Three constraints shape the
 * whole module:
 *
 * 1. **One client per MLS database.** Building a second client while the app is
 *    alive opens a second handle on the same SQLite file. `getActiveClient` is
 *    tried first, and `dropClient` runs only for a client this module built —
 *    never for the app's live one.
 * 2. **The OS kills background work.** A headless task gets a small budget, so
 *    the decrypt races a timeout and the caller falls back to generic copy. If
 *    the timeout wins, `processMessage` keeps running until it settles; the
 *    process usually exits first and the OS reclaims the handle. Best-effort by
 *    design.
 * 3. **Every miss looks the same.** No client, unknown conversation, decrypt
 *    error and timeout all return `null`, so the caller needs one fallback
 *    branch rather than four.
 *
 * Content types are the host's, so rendering is injected: `render` receives the
 * decoded message and the client that decoded it.
 *
 * Platform note: on iOS this runs inside a Notification Service Extension, which
 * needs `platform.dbDirectory` pointed at a shared App Group container so the
 * extension opens the same database (see the platform section of the README). On
 * Android it runs in a headless JS task.
 */

/**
 * The pushed fields this consumes. The names match XMTP's reference notification
 * server, so a stock deployment needs no translation; `encryptedMessage` is the
 * base64 `GroupMessage` protobuf that `processMessage` expects, not its inner
 * payload. A server emitting different names must map them to these.
 */
export type XmtpPushPayload = { topic: string; encryptedMessage: string /* base64 envelope */ };
export type ReceiverResult = { title: string; body: string; data?: Record<string, string> };

export type ReceiverDeps = {
  /** Build a no-signer client (with the host's codecs and credentials); null if unavailable. */
  buildClient: () => Promise<Client<any> | null>;
  /** Reuse a live client if the app is alive (avoids a second handle on the MLS DB). */
  getActiveClient?: () => Client<any> | null;
  /** Drop a client this module built (never the live one); pass the SDK's dropClient. */
  dropClient: (installationId: string) => Promise<void>;
  /** Map a decoded message to notification text; the host's content types are read here. */
  render: (decoded: DecodedMessage<any>, client: Client<any>) => Promise<ReceiverResult>;
  /** Best-effort budget; default 6000ms. */
  timeoutMs?: number;
};

/**
 * Builds or reuses a client, decrypts the pushed envelope with `processMessage`,
 * and renders it. Returns null on any miss so the caller can fall back to
 * generic copy.
 */
export async function decryptPushedMessage(
  payload: XmtpPushPayload,
  deps: ReceiverDeps,
): Promise<ReceiverResult | null> {
  const timeoutMs = deps.timeoutMs ?? 6000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });

  const work = (async (): Promise<ReceiverResult | null> => {
    const reused = deps.getActiveClient?.() ?? null;
    const client = reused ?? (await deps.buildClient());
    if (!client) return null;
    try {
      // cast contained here: the SDK wants its branded ConversationTopic, but the
      // public payload stays a plain string (it came off the wire as one).
      const conv = await client.conversations.findConversationByTopic(payload.topic as ConversationTopic);
      if (!conv) return null;
      const decoded = await conv.processMessage(payload.encryptedMessage);
      return await deps.render(decoded, client);
    } catch {
      return null;
      // NB: if the outer timeout wins the race, this finally still runs once
      // processMessage settles; in the headless-task case the process usually
      // exits first and the OS reclaims the DB handle. Best-effort by design.
    } finally {
      if (!reused) {
        try { await deps.dropClient(client.installationId); } catch { /* best-effort */ }
      }
    }
  })();

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
