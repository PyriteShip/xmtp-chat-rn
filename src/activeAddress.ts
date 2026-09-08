// The headless push handler runs in a fresh JS context with no React/wallet
// state, so the address that owns the local XMTP DB is persisted here (same MMKV
// store as the db encryption key) for the background decrypted-preview path.
import { createMMKV } from 'react-native-mmkv';

const KEY = 'activeAddress.v1';
let storage: ReturnType<typeof createMMKV> | null = null;
function store(): ReturnType<typeof createMMKV> {
  if (!storage) storage = createMMKV({ id: 'xmtp' });
  return storage;
}

export function getActiveXmtpAddress(): string | null {
  return store().getString(KEY) ?? null;
}
export function setActiveXmtpAddress(address: string): void {
  store().set(KEY, address.toLowerCase());
}
export function clearActiveXmtpAddress(): void {
  store().remove(KEY);
}
