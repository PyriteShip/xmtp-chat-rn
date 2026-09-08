/**
 * XMTP local-database encryption key, persisted in MMKV.
 *
 * XMTP encrypts its on-device message database with a caller-supplied 32-byte
 * key that must be stable across launches — a fresh key orphans the existing
 * db and forces a full re-sync. We persist it in MMKV (already a core
 * dependency) rather than expo-secure-store because this key guards a local
 * cache, not signing material — the XMTP identity itself is derived from
 * wallet signatures — so MMKV's non-hardware-backed storage is an acceptable
 * trade for correctness.
 *
 * `createMMKV` is called lazily, not at import time, so Nitro is not
 * instantiated just by importing this module. `createMMKV` memoizes per id.
 *
 * On iOS, the key is also mirrored into the App Group shared store
 * (`xmtp.dbEncryptionKey`) so the Notification Service Extension can open the
 * same MLS database for decrypted push previews.
 */

import { createMMKV } from 'react-native-mmkv';
import { fromByteArray, toByteArray } from 'react-native-quick-base64';
import { xmtpConfig } from './configure';

const KEY = 'dbEncryptionKey.v1';

let storage: ReturnType<typeof createMMKV> | null = null;
function store(): ReturnType<typeof createMMKV> {
  if (!storage) storage = createMMKV({ id: 'xmtp' });
  return storage;
}

/**
 * Persist `bytes` in MMKV and mirror into the App Group shared store (iOS only;
 * no-op on Android). Returns the same bytes for chaining.
 */
function persist(bytes: Uint8Array): Uint8Array {
  const b64 = fromByteArray(bytes);
  store().set(KEY, b64);
  xmtpConfig().platform?.setSharedItem?.('xmtp.dbEncryptionKey', b64); // iOS-only mirror for the NSE (no-op elsewhere)
  return bytes;
}

/**
 * Returns the 32-byte XMTP db encryption key, generating and persisting one on
 * first call. Stored base64-encoded because MMKV holds strings.
 */
export function getOrCreateXmtpDbEncryptionKey(): Uint8Array {
  const existing = store().getString(KEY);
  if (existing) {
    try {
      const bytes = toByteArray(existing);
      if (bytes.length === 32) return persist(bytes);
    } catch {
      // Corrupt value — fall through and regenerate.
    }
  }
  const key = new Uint8Array(32);
  // Global CSPRNG, polyfilled app-wide via react-native-get-random-values
  // (the host installs it).
  crypto.getRandomValues(key);
  return persist(key);
}
