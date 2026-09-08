import type { Client } from '@xmtp/react-native-sdk';

/**
 * XMTP push registration, and the reachability gate that must run before any of
 * it.
 *
 * `XMTPPush.register` and the native topic-subscribe call both run on the shared
 * XMTP native runtime, not as a JS-cancellable request: against a port with no
 * route (e.g. a raw-TCP service on a host with no dedicated IPv4) the call hangs, and
 * because the runtime is shared, that hang wedges the whole XMTP client — the
 * Inbox's `syncAllConversations` then blocks forever. JS cannot open a raw socket
 * to test the route itself, so `isPushServerReachable` fetches a probe URL with a
 * timeout instead: a timeout (`AbortError`) means no route, so push is skipped
 * entirely — the native call would hang the same way. Any other outcome — an HTTP
 * response, a protocol error, connection refused — means the port answered, so
 * it's safe to hand control to the native client (on Android the gRPC port speaks
 * h2c, not HTTP/1.1, so it rejects the probe quickly, but the port is reachable).
 * A consumer that reimplements registration without this gate reproduces the hang.
 *
 * `@xmtp/react-native-sdk` is imported lazily inside the functions that need it
 * (`await import(...)`), not at module scope, so the pure reachability gate above
 * stays importable under Jest without pulling in the SDK's native/ESM module graph.
 */

const PROBE_TIMEOUT_MS = 3000;

let serverUrl: string | null = null;
let probeUrl: string | null = null;
let cached: Promise<boolean> | null = null;

/**
 * Sets the host strings this module dials. `serverUrl` is handed verbatim to the
 * native `XMTPPush` client; `probeUrl` is a separate field, not derived from it —
 * on Android it's the raw gRPC TCP port, on iOS the HTTPS `/healthz`, and neither
 * equals `serverUrl`. Call once at app startup, before anything can reach the
 * gate below.
 */
export function configureXmtpPush(opts: { serverUrl: string; probeUrl: string }): void {
  serverUrl = opts.serverUrl;
  probeUrl = opts.probeUrl;
}

/**
 * Best-effort check that the push server answers, run BEFORE handing control to
 * the native `XMTPPush` client. Memoised for the session — a network switch
 * reloads the JS bundle, which re-initialises this module and clears the cache,
 * so no manual reset is needed.
 */
export function isPushServerReachable(): Promise<boolean> {
  if (!cached) cached = probe();
  return cached;
}

async function probe(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(probeUrl!, { signal: controller.signal });
    return true;
  } catch (err: any) {
    // AbortError === our timeout fired === no route. Anything else means the
    // server was actually reached.
    return err?.name !== 'AbortError';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Subscribe the installation to every current conversation topic. The native layer
 * attaches the per-topic HMAC keys and calls SubscribeWithMetadata. Idempotent —
 * call again whenever the conversation list grows so newly-created conversations
 * also push when the app is closed (an initial `registerXmtpPush` only covers
 * topics that existed at connect time).
 */
export async function subscribeConversationTopics(client: Client<any>): Promise<void> {
  // Gated the same way as registration below: an unreachable server would hang
  // this native call and wedge the shared XMTP client.
  if (!(await isPushServerReachable())) return;
  try {
    const convos = await client.conversations.list();
    const topics = convos.map((c) => c.topic);
    if (topics.length > 0) {
      const { XMTPPush } = await import('@xmtp/react-native-sdk');
      await new XMTPPush(client).subscribe(topics);
    }
  } catch (err: any) {
    console.warn('[push] XMTP subscribe failed', err?.message ?? err);
  }
}

/**
 * Register this installation's FCM token for XMTP message pushes, then subscribe
 * it to every conversation topic that exists right now. No-ops when the push
 * server is unreachable, per the gate above.
 */
export async function registerXmtpPush(client: Client<any>, token: string): Promise<void> {
  if (!(await isPushServerReachable())) {
    console.warn('[push] push server unreachable; skipping XMTP registration this session');
    return;
  }
  const { XMTPPush } = await import('@xmtp/react-native-sdk');
  XMTPPush.register(serverUrl!, token);
  await subscribeConversationTopics(client);
}

/** Test-only: clears the memoised reachability check between test cases. */
export function __resetPushProbe(): void {
  cached = null;
}
