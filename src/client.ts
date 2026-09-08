/**
 * XMTP client lifecycle — one client per connected wallet, module-singleton.
 *
 * `getOrCreateXmtpClient(identity)` is idempotent per address: repeated calls
 * for the same address return the same in-flight/resolved client. Switching
 * addresses (or disconnecting) drops the old client first. Creation prompts
 * the signer to sign XMTP's one-time auth message (per installation).
 */

import {
  Client,
  PublicIdentity,
  ReactionCodec,
  ReactionV2Codec,
  ReplyCodec,
  type Signer as XmtpSigner,
} from '@xmtp/react-native-sdk';
import { xmtpConfig } from './configure';
import { getOrCreateXmtpDbEncryptionKey } from './dbKey';
import { setActiveXmtpAddress, clearActiveXmtpAddress } from './activeAddress';

/**
 * Content codecs registered on every client. Both parties run this app, so both
 * register these; older/other clients fall back to each card's text `fallback`.
 *
 * The three standard types are XMTP's own rather than ours — quoted replies and
 * emoji reactions ride the interoperable wire format, so a reaction or reply
 * from any XMTP client lands correctly in our thread and ours lands in theirs.
 * Both reaction versions are registered: v2 is what we send, v1 decodes
 * reactions from clients that predate it.
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
    ...xmtpConfig().cards.map((card) => card.codec),
  ];
}

// Client<any> so the codecs generic from Client.create({ codecs }) assigns
// cleanly to the module singletons without threading the codec tuple type.
let initPromise: Promise<Client<any>> | null = null;
let activeClient: Client<any> | null = null;
let activeAddress: string | null = null;

// Listeners notified whenever the client lifecycle changes (init started,
// ready, failed, dropped). Lets screens — e.g. the Inbox — re-render when the
// client finishes coming up after sign-in instead of latching a stale
// "unavailable" state until the next focus.
const lifecycleListeners = new Set<() => void>();
function notifyLifecycle(): void {
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

/** A wallet identity ready for the transport: an address plus the XMTP
 *  `Signer` built for it. `address` travels alongside `signer` (rather than
 *  being derived from it) because per-address idempotence below is checked
 *  before any `await`, and `Signer.getIdentifier()` is async. */
export interface XmtpIdentity {
  address: string;
  signer: XmtpSigner;
}

export async function getOrCreateXmtpClient(identity: XmtpIdentity): Promise<Client> {
  const addr = identity.address.toLowerCase();
  if (activeAddress === addr && initPromise) {
    return initPromise;
  }
  // Different wallet than the one we have a client for — tear it down first.
  if (activeAddress && activeAddress !== addr) {
    await dropXmtpClient();
  }
  activeAddress = addr;
  // Diagnostic: pairs with the "ready"/"failed" logs below so logcat shows
  // whether a live session even attempts client creation (degraded never does)
  // and, if it does, whether Client.create succeeds or throws.
  console.log('[xmtp] creating client for', addr);
  initPromise = (async () => {
    const { env, platform, devInstallationPrune } = xmtpConfig();
    platform?.migrateDbIfNeeded?.(); // iOS-only one-time copy of the db into the App Group (no-op elsewhere)
    const dbEncryptionKey = getOrCreateXmtpDbEncryptionKey();
    const dbDirectory = platform?.dbDirectory?.() ?? undefined; // iOS App Group; undefined on Android
    const signer = identity.signer;
    const createOpts = { env, dbEncryptionKey, dbDirectory, codecs: codecs() };
    let client: Client<any>;
    try {
      client = await Client.create(signer, createOpts);
    } catch (err: any) {
      // The inbox is at XMTP's 10-installation cap and this (wiped-DB) launch
      // can't register a new one. In dev, free the orphaned slots and retry once
      // so messaging self-heals instead of staying permanently wedged.
      if (devInstallationPrune && isInstallationLimitError(err)) {
        await recoverFromInstallationLimit(signer, addr);
        client = await Client.create(signer, createOpts);
      } else {
        throw err;
      }
    }
    activeClient = client;
    setActiveXmtpAddress(addr);
    platform?.setSharedItem?.('xmtp.activeAddress', addr); // NSE reads this to know which identity to build
    console.log('[xmtp] client ready for', addr);
    // Dev hygiene: each `pm clear` reinstall registers a fresh installation
    // against XMTP's 10-per-inbox cap, eventually wedging client creation
    // ("already registered 10/10 installations"). Prune the orphans on sign-in.
    // Fire-and-forget so the client is usable immediately; revokes only OTHER
    // installations, so the current one's local message history is preserved.
    // Gated on `devInstallationPrune`: revocation needs a wallet signature
    // (silent for dev wallets, a prompt for real ones), so a production
    // configuration never auto-revokes.
    if (devInstallationPrune) void pruneOrphanedInstallations(client, signer);
    return client;
  })();
  notifyLifecycle(); // init started — observers can show a spinner
  // When the client is ready, notify so the Inbox reloads on its own.
  initPromise.then(
    () => notifyLifecycle(),
    // If creation throws (e.g. SCW signature rejected), clear the cached promise
    // so a later retry can re-run rather than re-await a rejected promise.
    (err) => {
      console.warn('[xmtp] client creation failed for', addr, err?.message ?? err);
      if (activeAddress === addr) {
        initPromise = null;
        activeAddress = null;
      }
      notifyLifecycle();
    },
  );
  return initPromise;
}

/** True when Client.create failed because the inbox is at XMTP's 10-installation cap. */
function isInstallationLimitError(err: any): boolean {
  return /10\/10|already registered|installation limit|maximum number of installations/i.test(
    String(err?.message ?? err),
  );
}

/**
 * Recover from a maxed-out inbox: with the local DB wiped there is no current
 * installation to preserve, so every registered installation is an orphan from a
 * prior `pm clear`. Resolve the inbox statically (no client needed — create just
 * failed) and revoke them all so the caller's retry can register a fresh one.
 * Gated by the caller on `devInstallationPrune`, so this never revokes a real
 * user's other devices.
 */
async function recoverFromInstallationLimit(signer: XmtpSigner, address: string): Promise<void> {
  const { env } = xmtpConfig();
  const identity = new PublicIdentity(address.toLowerCase(), 'ETHEREUM');
  const inboxId = await Client.getOrCreateInboxId(identity, env);
  const [state] = await Client.inboxStatesForInboxIds(env, [inboxId]);
  const ids = (state?.installations ?? []).map((i) => i.id);
  if (ids.length === 0) return;
  // installations[].id is `string`; revokeInstallations wants the branded
  // InstallationId[] (not exported) — cast via the method's own parameter type.
  await Client.revokeInstallations(env, signer, inboxId, ids as Parameters<typeof Client.revokeInstallations>[3]);
  console.log(`[xmtp] recovered from installation limit — revoked ${ids.length} installation(s)`);
}

/**
 * Revoke installations other than the current one, freeing slots against XMTP's
 * 10-per-inbox cap. Keeps the current installation (and its local history) — only
 * orphans from prior `pm clear` reinstalls are revoked. Best-effort: any failure
 * (offline, signature declined) is logged and swallowed; messaging still works.
 * Skips the revocation signature entirely when there are no orphans to prune.
 */
async function pruneOrphanedInstallations(client: Client<any>, signer: XmtpSigner): Promise<void> {
  try {
    const state = await client.inboxState(true); // refresh from network
    const others = state.installations.filter((i) => i.id !== client.installationId);
    if (others.length === 0) return; // nothing to revoke — don't prompt for a signature
    await client.revokeAllOtherInstallations(signer);
    console.log(`[xmtp] pruned ${others.length} orphaned installation(s) (${state.installations.length} → 1)`);
  } catch (e: any) {
    console.warn('[xmtp] installation prune failed (non-fatal)', e?.message ?? e);
  }
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
 * against XMTP's 10-per-inbox cap; the create-time cap recovery and the dev
 * prune in getOrCreateXmtpClient absorb the orphan this leaves behind.
 */
export async function resetXmtpLocalState(identity: XmtpIdentity): Promise<Client> {
  const client = activeClient;
  activeClient = null;
  initPromise = null;
  activeAddress = null;
  clearActiveXmtpAddress();
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
  activeClient = null;
  initPromise = null;
  activeAddress = null;
  clearActiveXmtpAddress();
  notifyLifecycle();
  if (client) {
    try {
      await Client.dropClient(client.installationId);
    } catch {
      // Best-effort — the client is being discarded regardless.
    }
  }
}
