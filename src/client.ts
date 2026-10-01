/**
 * XMTP client lifecycle — one client per connected wallet, module-singleton.
 *
 * `getOrCreateXmtpClient(identity)` is idempotent per address: repeated calls
 * for the same address return the same in-flight/resolved client. Switching
 * addresses (or disconnecting) drops the old client first. Creation prompts
 * the signer to sign XMTP's one-time auth message (per installation), and is
 * bounded by `clientCreateTimeoutMs` so a hung attempt cannot hold the
 * single-flight entry forever.
 *
 * `openXmtpClient(address)` brings up the same singleton with no signer at
 * all, from the installation this device already registered. The wallet signs
 * once per installation; reading, streaming and sending afterwards use the
 * installation's own keys in the local database, so a host whose wallet
 * session has lapsed can keep messaging working.
 */

import {
  Client,
  MultiRemoteAttachmentCodec,
  PublicIdentity,
  ReactionCodec,
  ReactionV2Codec,
  ReadReceiptCodec,
  RemoteAttachmentCodec,
  ReplyCodec,
  StaticAttachmentCodec,
  type Signer as XmtpSigner,
} from '@xmtp/react-native-sdk';
import { xmtpConfig } from './configure';
import { getOrCreateXmtpDbEncryptionKey } from './dbKey';
import { setActiveXmtpAddress, clearActiveXmtpAddress } from './activeAddress';
import { clearAttachmentCache } from './attachmentCache';
import { forgetInboundHandledCache } from './inboundMessages';

/**
 * Content codecs registered on every client. Both parties run this app, so both
 * register these; older/other clients fall back to each card's text `fallback`.
 *
 * The standard types are XMTP's own rather than ours — quoted replies, emoji
 * reactions and read receipts ride the interoperable wire format, so one from
 * any XMTP client lands correctly in our thread and ours lands in theirs.
 * Both reaction versions are registered: v2 is what we send, v1 decodes
 * reactions from clients that predate it.
 *
 * The read-receipt codec is registered unconditionally, even for a host that
 * leaves `readReceipts` off. Registration is what lets an inbound receipt
 * decode; sending is the part the flag gates. A host that opts out still wants
 * a counterparty's receipt to decode to nothing rather than to an unknown
 * content type that lands in the thread as a blank bubble.
 *
 * All three attachment codecs are registered whether or not the host
 * configured `attachments`, for the same reason as receipts: registration is
 * what lets another client's attachment decode instead of landing as an
 * unknown type. Only the single remote one renders as a bubble/card of its
 * own; an inline static attachment and a multi remote attachment (several
 * files in one message) both show their text fallback instead — this
 * package renders neither's actual file(s).
 *
 * The custom types come from `xmtpConfig().cards` — the host's card registry,
 * supplied at `configureXmtpChat` time — so this module stays ignorant of what
 * any of them mean. Built fresh on every call rather than once at module scope:
 * the registry isn't known until configure time, which is strictly later than
 * this module's import time, so a module-level constant would capture an empty
 * (or unconfigured) registry.
 */
export function codecs() {
  return [
    new ReplyCodec(),
    new ReactionV2Codec(),
    new ReactionCodec(),
    new ReadReceiptCodec(),
    new RemoteAttachmentCodec(),
    new StaticAttachmentCodec(),
    new MultiRemoteAttachmentCodec(),
    ...xmtpConfig().cards.map((card) => card.codec),
  ];
}

// Client<any> so the codecs generic from Client.create({ codecs }) assigns
// cleanly to the module singletons without threading the codec tuple type.
let initPromise: Promise<Client<any>> | null = null;
let activeClient: Client<any> | null = null;
let activeAddress: string | null = null;
// The identity of the most recent attempt and why it failed, kept past a
// failure so `retryXmtpClient` can re-run it without the host re-supplying
// anything. It carries no signer when the attempt was an `openXmtpClient`.
// Both clear on sign-out (`dropXmtpClient`).
let lastIdentity: AttemptIdentity | null = null;
let lastError: string | null = null;
// Whether the attempt behind `initPromise` holds a signer. A signer-less open
// that fails says only that this device has no usable installation, so a
// caller that does hold a signer goes on to create one instead of inheriting
// that failure.
let attemptHasSigner = false;
let retryPromise: Promise<Client<any> | null> | null = null;
const readyListeners = new Set<(client: Client<any>, address: string) => void>();

// Listeners notified whenever the client lifecycle changes (init started,
// ready, failed, dropped). Lets screens — e.g. the Inbox — re-render when the
// client finishes coming up after sign-in instead of latching a stale
// "unavailable" state until the next focus.
const lifecycleListeners = new Set<() => void>();
function notifyLifecycle(): void {
  statusSnapshot = deriveStatus();
  for (const cb of lifecycleListeners) cb();
}
export function subscribeXmtpClient(cb: () => void): () => void {
  lifecycleListeners.add(cb);
  return () => { lifecycleListeners.delete(cb); };
}

/** True while a client is being created but hasn't resolved yet (the window
 *  right after sign-in). Distinguishes "still coming up" from "no client". */
export function isXmtpClientInitializing(): boolean {
  return !activeClient && !!initPromise;
}

/**
 * Where client creation stands. `failed` is kept until a retry succeeds or the
 * wallet signs out, so a surface can say messaging is unavailable *and* offer
 * the way back — `clientAvailable: false` alone is a dead end. A failed
 * `openXmtpClient` carries `withoutSigner`: nothing was asked of the wallet, so
 * the way back is usually a creation with a signer rather than a retry.
 */
export type XmtpClientStatus =
  | { state: 'idle' }
  | { state: 'initializing'; address: string }
  | { state: 'ready'; address: string; client: Client<any> }
  | { state: 'failed'; address: string; error: string; withoutSigner?: true };

function deriveStatus(): XmtpClientStatus {
  if (activeClient && activeAddress) return { state: 'ready', address: activeAddress, client: activeClient };
  if (initPromise && activeAddress) return { state: 'initializing', address: activeAddress };
  if (lastIdentity && lastError !== null) {
    const failed = { state: 'failed' as const, address: lastIdentity.address.toLowerCase(), error: lastError };
    return lastIdentity.signer ? failed : { ...failed, withoutSigner: true };
  }
  return { state: 'idle' };
}

// Cached so repeated reads return the same object between changes, which is
// what `useSyncExternalStore` requires; refreshed in `notifyLifecycle`.
let statusSnapshot: XmtpClientStatus = { state: 'idle' };

/** Current creation status. Pair with `subscribeXmtpClient` for changes. */
export function getXmtpClientStatus(): XmtpClientStatus {
  return statusSnapshot;
}

/**
 * Called with each client that finishes coming up — the first creation, one a
 * retry recovered, or one `resetXmtpLocalState` rebuilt. Hang post-create
 * wiring (message notifications, push registration) here rather than after
 * awaiting your own `getOrCreateXmtpClient` call: creation can be retried from
 * any surface, and only this runs for every client regardless of who started
 * it. Not called for callers that join a client already up. Subscribe at
 * startup, before creating one — a client that is already ready is not
 * replayed. Returns the unsubscribe.
 */
export function onXmtpClientReady(cb: (client: Client<any>, address: string) => void): () => void {
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/**
 * Re-run the attempt that failed — a creation with the signer it was given, or
 * a signer-less open — without the host re-supplying anything. Resolves the
 * live client when one is already up, null
 * when there is nothing to retry (never requested, or signed out) or when the
 * retry fails too — never rejects, so a caller can await it purely to drive a
 * spinner, and read the reason from `getXmtpClientStatus`. Concurrent calls
 * share one attempt.
 *
 * Deciding *when* to retry unprompted is the host's call: creation may need a
 * wallet signature, and for a wallet that signs in another app that means an
 * app switch nobody asked for.
 */
export function retryXmtpClient(): Promise<Client<any> | null> {
  if (activeClient) return Promise.resolve(activeClient);
  if (initPromise) return initPromise.catch(() => null);
  if (retryPromise) return retryPromise;
  const identity = lastIdentity;
  if (!identity) return Promise.resolve(null);
  const rerun = identity.signer
    ? getOrCreateXmtpClient({ address: identity.address, signer: identity.signer })
    : openXmtpClient(identity.address);
  const attempt = rerun.then(
    (c) => c as Client<any>,
    () => null,
  );
  retryPromise = attempt.finally(() => { retryPromise = null; });
  return retryPromise;
}

/** A wallet identity ready for the transport: an address plus the XMTP
 *  `Signer` built for it. `address` travels alongside `signer` (rather than
 *  being derived from it) because per-address idempotence below is checked
 *  before any `await`, and `Signer.getIdentifier()` is async. */
export interface XmtpIdentity {
  address: string;
  signer: XmtpSigner;
}

/** What an attempt runs with: a full identity, or an address alone for a
 *  signer-less open. */
interface AttemptIdentity {
  address: string;
  signer?: XmtpSigner;
}

/** How long a creation attempt may run before it is abandoned, when the host
 *  leaves `clientCreateTimeoutMs` unset. Creation can wait on a wallet
 *  signature, so the bound is generous. */
export const DEFAULT_CLIENT_CREATE_TIMEOUT_MS = 60_000;

/**
 * The rejection of a creation attempt that ran past `clientCreateTimeoutMs`.
 * Recognise it with `isXmtpClientCreateTimeoutError`, which also holds across
 * duplicate copies of this package where `instanceof` does not.
 */
export class XmtpClientCreateTimeoutError extends Error {
  readonly code = 'XMTP_CLIENT_CREATE_TIMEOUT';
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`XMTP client creation timed out after ${timeoutMs}ms`);
    this.name = 'XmtpClientCreateTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function isXmtpClientCreateTimeoutError(err: unknown): err is XmtpClientCreateTimeoutError {
  return (err as { code?: unknown } | null)?.code === 'XMTP_CLIENT_CREATE_TIMEOUT';
}

// Identifies the creation attempt whose outcome the module state reflects.
// Every new attempt, sign-out and local-state reset advances it, so an attempt
// that settles after being superseded sees a different value and changes
// nothing.
let attemptGeneration = 0;

function resolveCreateTimeoutMs(): number | null {
  const configured = xmtpConfig().clientCreateTimeoutMs;
  if (configured === undefined) return DEFAULT_CLIENT_CREATE_TIMEOUT_MS;
  if (configured === null || !Number.isFinite(configured) || configured <= 0) return null;
  return configured;
}

export async function getOrCreateXmtpClient(identity: XmtpIdentity): Promise<Client> {
  const addr = identity.address.toLowerCase();
  if (activeAddress === addr && initPromise) {
    // Same wallet, now with a signer: later retries and recoveries can use it.
    lastIdentity = identity;
    if (activeClient || attemptHasSigner) return initPromise;
    // A signer-less open is in flight. Its client serves this caller too; if it
    // fails, create with the signer — unless the wallet signed out or switched
    // meanwhile, in which case this identity is no longer the one to start.
    return initPromise.catch((err) => {
      if (lastIdentity?.address.toLowerCase() !== addr) throw err;
      return getOrCreateXmtpClient(identity);
    });
  }
  return startAttempt(identity, addr);
}

/**
 * Bring the client up for `address` with no signer, from the installation this
 * device already registered. Nothing is signed and nothing is registered: the
 * local database holds the installation's keys, and those are what read,
 * stream and send. Use it where the wallet cannot sign right now — a session
 * that lapsed — so messaging outlives the session that set it up.
 *
 * Rejects when this device has no registered installation for the address (it
 * never created one, or its database was deleted); status turns `failed` and a
 * later `getOrCreateXmtpClient` with a signer creates one. Shares the
 * single-flight entry with `getOrCreateXmtpClient`: a call for an address whose
 * client is up or coming up joins it. Calls that need a signature — revoking
 * installations, `resetXmtpLocalState` — still take a full `XmtpIdentity`.
 */
export async function openXmtpClient(address: string): Promise<Client> {
  const addr = address.toLowerCase();
  if (activeAddress === addr && initPromise) return initPromise;
  return startAttempt({ address }, addr);
}

/** Starts the one attempt for `addr` and makes it the single-flight entry. */
async function startAttempt(identity: AttemptIdentity, addr: string): Promise<Client> {
  // Different wallet than the one we have a client for — tear it down first.
  if (activeAddress && activeAddress !== addr) {
    await dropXmtpClient();
  }
  activeAddress = addr;
  lastIdentity = identity;
  attemptHasSigner = identity.signer !== undefined;
  const generation = ++attemptGeneration;
  // Diagnostic: pairs with the "ready"/"failed" logs below so logcat shows
  // whether an attempt started, which kind, and whether the SDK call succeeded
  // or threw.
  console.log(identity.signer ? '[xmtp] creating client for' : '[xmtp] opening client for', addr);
  const made = identity.signer ? createClient(identity.signer, addr) : buildClient(addr);
  const settled = made.then(
    (client) => {
      adoptClient(client, addr, generation);
      return client;
    },
    (err) => {
      failAttempt(err, addr, generation);
      throw err;
    },
  );
  const timeoutMs = resolveCreateTimeoutMs();
  const attempt = timeoutMs === null ? settled : withCreateTimeout(settled, timeoutMs, addr, generation);
  initPromise = attempt;
  notifyLifecycle(); // init started — observers can show a spinner
  return attempt;
}

/**
 * Runs creation, bounded by `timeoutMs`. At the deadline the returned promise
 * rejects with `XmtpClientCreateTimeoutError` and, if the attempt is still the
 * current one, the single-flight entry clears and status turns `failed`, so the
 * next call (or `retryXmtpClient`) starts a fresh attempt instead of rejoining
 * the hung one. The abandoned attempt keeps running: it cannot be cancelled,
 * because the SDK exposes no way to cancel `Client.create`.
 */
function withCreateTimeout(
  settled: Promise<Client<any>>,
  timeoutMs: number,
  addr: string,
  generation: number,
): Promise<Client<any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new XmtpClientCreateTimeoutError(timeoutMs);
      console.warn('[xmtp] client creation timed out for', addr, `after ${timeoutMs}ms`);
      if (generation === attemptGeneration && !activeClient) {
        initPromise = null;
        activeAddress = null;
        lastError = err.message;
        notifyLifecycle();
      }
      reject(err);
    }, timeoutMs);
    settled.then(
      (client) => { clearTimeout(timer); resolve(client); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** The options every client is opened with, created or built. */
function clientOptions() {
  const { env, platform } = xmtpConfig();
  platform?.migrateDbIfNeeded?.(); // iOS-only one-time copy of the db into the App Group (no-op elsewhere)
  const dbEncryptionKey = getOrCreateXmtpDbEncryptionKey();
  const dbDirectory = platform?.dbDirectory?.() ?? undefined; // iOS App Group; undefined on Android
  return { env, dbEncryptionKey, dbDirectory, codecs: codecs() };
}

/**
 * Builds the client for `addr` from this device's existing installation,
 * without touching module state. The SDK's `build` takes no signer, so it
 * cannot register anything: with no registered installation in the local
 * database it rejects.
 */
async function buildClient(addr: string): Promise<Client<any>> {
  return Client.build(new PublicIdentity(addr, 'ETHEREUM'), clientOptions());
}

/**
 * Creates the client for `addr` without touching module state; the attempt's
 * outcome is applied by `adoptClient` / `failAttempt`.
 */
async function createClient(signer: XmtpSigner, addr: string): Promise<Client<any>> {
  const { devInstallationPrune } = xmtpConfig();
  const createOpts = clientOptions();
  // Invariant: sign-in never revokes installations. The same wallet is
  // signed in on other physical devices, and revoking another device's
  // installation makes that device's sends silently undeliverable — it
  // keeps "sending" while every recipient drops its messages. The only
  // revocation this module performs is the at-cap recovery below, and it
  // frees one slot, never the whole inbox. Do not add an eager prune here,
  // under `devInstallationPrune` or any other flag.
  try {
    return await Client.create(signer, createOpts);
  } catch (err: any) {
    // The inbox is at XMTP's 10-installation cap and this (wiped-DB) launch
    // can't register a new one. In dev, free one slot — the oldest
    // installation, the one most likely to be an orphan — and retry once so
    // messaging self-heals instead of staying permanently wedged.
    if (devInstallationPrune && isInstallationLimitError(err)) {
      await recoverFromInstallationLimit(signer, addr);
      return await Client.create(signer, createOpts);
    }
    throw err;
  }
}

/**
 * Makes a created client the active one and announces it — only when its
 * attempt is still the current one. That includes an attempt that already
 * timed out: if nothing started since, no other client can arrive, and a
 * working client for the signed-in wallet beats a `failed` status. An attempt
 * superseded by a newer attempt, a sign-out or a reset is ignored, so it can
 * neither replace the newer client nor announce a second one. The ignored
 * client is not dropped: an attempt for the same wallet shares its
 * installation, and dropping it would drop the newer client with it.
 */
function adoptClient(client: Client<any>, addr: string, generation: number): void {
  if (generation !== attemptGeneration || activeClient) {
    console.log('[xmtp] ignoring client from a superseded attempt for', addr);
    return;
  }
  activeClient = client;
  activeAddress = addr;
  // A timed-out attempt cleared the single-flight entry; restore one so later
  // callers join this client rather than create another.
  if (!initPromise) initPromise = Promise.resolve(client);
  lastError = null;
  setActiveXmtpAddress(addr);
  xmtpConfig().platform?.setSharedItem?.('xmtp.activeAddress', addr); // NSE reads this to know which identity to build
  console.log('[xmtp] client ready for', addr);
  notifyLifecycle();
  // When the client is ready, notify so the Inbox reloads on its own.
  for (const cb of readyListeners) {
    try {
      cb(client, addr);
    } catch (e: any) {
      console.warn('[xmtp] onXmtpClientReady listener threw', e?.message ?? e);
    }
  }
}

/**
 * Records a failed attempt (e.g. SCW signature rejected) and clears the cached
 * promise so a later retry re-runs rather than re-awaits a rejected promise.
 * A superseded attempt — including one that already timed out and was
 * followed by another — records nothing.
 */
function failAttempt(err: any, addr: string, generation: number): void {
  console.warn('[xmtp] client creation failed for', addr, err?.message ?? err);
  if (generation !== attemptGeneration || activeClient) return;
  const timedOut = initPromise === null;
  initPromise = null;
  activeAddress = null;
  // A timed-out attempt already reports the timeout; its eventual rejection
  // is the reason it hung, which the log above keeps.
  if (!timedOut) lastError = String(err?.message ?? err);
  notifyLifecycle();
}

/** True when Client.create failed because the inbox is at XMTP's 10-installation cap. */
function isInstallationLimitError(err: any): boolean {
  return /10\/10|already registered|installation limit|maximum number of installations/i.test(
    String(err?.message ?? err),
  );
}

/**
 * Recover from a maxed-out inbox by freeing exactly the slots the retry needs.
 * Resolves the inbox statically (no client exists — create just failed), sorts
 * its installations oldest-first by `createdAt` (milliseconds; an installation
 * whose age is unknown sorts last, since it cannot be shown to be old), and
 * revokes the oldest `max(1, count - (cap - 1))` — one for an inbox exactly at
 * the cap. The rest of the inbox is left alone: any of those installations may
 * be this wallet on another physical device, and a revoked device's sends are
 * silently undeliverable. Gated by the caller on `devInstallationPrune`, since
 * revocation needs a wallet signature.
 */
async function recoverFromInstallationLimit(signer: XmtpSigner, address: string): Promise<void> {
  const { env } = xmtpConfig();
  const identity = new PublicIdentity(address.toLowerCase(), 'ETHEREUM');
  const inboxId = await Client.getOrCreateInboxId(identity, env);
  const [state] = await Client.inboxStatesForInboxIds(env, [inboxId]);
  const ids = oldestInstallationIds(state?.installations ?? []);
  if (ids.length === 0) return;
  // installations[].id is `string`; revokeInstallations wants the branded
  // InstallationId[] (not exported) — cast via the method's own parameter type.
  await Client.revokeInstallations(env, signer, inboxId, ids as Parameters<typeof Client.revokeInstallations>[3]);
  console.log(`[xmtp] recovered from installation limit — revoked ${ids.length} oldest installation(s)`);
}

/** XMTP's per-inbox installation cap. */
const INSTALLATION_CAP = 10;

/**
 * The ids of the oldest installations whose revocation leaves room for one
 * more under `INSTALLATION_CAP`. Ascending by `createdAt`; unknown ages last.
 */
function oldestInstallationIds(
  installations: readonly { id: string; createdAt?: number | undefined }[],
): string[] {
  if (installations.length === 0) return [];
  const needed = Math.max(1, installations.length - (INSTALLATION_CAP - 1));
  const byAge = [...installations].sort((a, b) => {
    if (a.createdAt === undefined) return b.createdAt === undefined ? 0 : 1;
    if (b.createdAt === undefined) return -1;
    return a.createdAt - b.createdAt;
  });
  return byAge.slice(0, needed).map((i) => i.id);
}

/**
 * Recovery of last resort for wedged local MLS state: a conversation whose
 * commits no longer validate against the cached association state rejects
 * every sync/create retry (surfaces as `GroupError::Sync` /
 * `ClientError::Group` with an `InboxValidationFailed` for our OWN inbox in
 * the native log), and no amount of retrying can clear it. Deletes the local
 * XMTP database, drops the client, and creates a fresh one for the same
 * wallet — a new installation with clean group state. Message history held
 * only on this device is not recoverable afterward (MLS forward secrecy), so
 * callers must confirm with the user first. The fresh installation counts
 * against XMTP's 10-per-inbox cap; the create-time cap recovery in
 * getOrCreateXmtpClient frees a slot once the orphans this leaves behind fill it.
 */
export async function resetXmtpLocalState(identity: XmtpIdentity): Promise<Client> {
  const client = activeClient;
  attemptGeneration++;
  activeClient = null;
  initPromise = null;
  activeAddress = null;
  clearActiveXmtpAddress();
  // Drop the decrypted-attachment cache (attachmentCache.ts) as part of
  // identity teardown, so a file decrypted under the wallet whose local
  // state is being wiped is not still reachable in memory after switching to
  // a different one.
  clearAttachmentCache();
  notifyLifecycle();
  if (client) {
    try {
      await client.deleteLocalDatabase();
    } catch (e: any) {
      // Deletion is best-effort: Client.create below still re-registers a
      // working installation even over a leftover database file.
      console.warn('[xmtp] deleteLocalDatabase failed', e?.message ?? e);
    }
    try {
      await Client.dropClient(client.installationId);
    } catch {
      // Best-effort — the client is being discarded regardless.
    }
  }
  console.log('[xmtp] local state reset — recreating client');
  return getOrCreateXmtpClient(identity);
}

/** The resolved client, or null if none has finished initializing. */
export function getActiveXmtpClient(): Client<any> | null {
  return activeClient;
}

export async function dropXmtpClient(): Promise<void> {
  const client = activeClient;
  attemptGeneration++;
  activeClient = null;
  initPromise = null;
  activeAddress = null;
  lastIdentity = null;
  lastError = null;
  attemptHasSigner = false;
  clearActiveXmtpAddress();
  // Drop the decrypted-attachment cache (attachmentCache.ts) as part of
  // sign-out, so a file decrypted under the wallet that just signed out is
  // not still reachable in memory after switching to a different one.
  clearAttachmentCache();
  forgetInboundHandledCache();
  notifyLifecycle();
  if (client) {
    try {
      await Client.dropClient(client.installationId);
    } catch {
      // Best-effort — the client is being discarded regardless.
    }
  }
}

/**
 * Revokes every installation of the identity's inbox — this device's included —
 * then drops the active client. Used by account deletion: afterwards no device
 * can read the inbox's history, and a later sign-in creates a fresh installation.
 * Returns the number of installations revoked.
 */
export async function revokeAllInstallations(identity: XmtpIdentity): Promise<number> {
  const { env } = xmtpConfig();
  const publicIdentity = new PublicIdentity(identity.address.toLowerCase(), 'ETHEREUM');
  const inboxId = await Client.getOrCreateInboxId(publicIdentity, env);
  const [state] = await Client.inboxStatesForInboxIds(env, [inboxId]);
  const ids = (state?.installations ?? []).map((i) => i.id);
  if (ids.length > 0) {
    // installations[].id is `string`; revokeInstallations wants the branded
    // InstallationId[] (not exported) — cast via the method's own parameter type.
    await Client.revokeInstallations(env, identity.signer, inboxId, ids as Parameters<typeof Client.revokeInstallations>[3]);
  }
  await dropXmtpClient();
  return ids.length;
}
