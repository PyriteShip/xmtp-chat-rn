import { jest } from '@jest/globals';

const mockSetShared = jest.fn();
jest.mock('react-native-mmkv', () => {
  const m = new Map<string, string>();
  return { createMMKV: () => ({ getString: (k: string) => m.get(k), set: (k: string, v: string) => m.set(k, v) }) };
});

import { configureXmtpChat } from './configure';
import { getOrCreateXmtpDbEncryptionKey } from './dbKey';

configureXmtpChat({
  env: 'dev',
  enabled: true,
  cards: [],
  platform: { setSharedItem: (k: string, v: string) => mockSetShared(k, v) },
});

test('mirrors the db key into the App-Group shared store (base64)', () => {
  const key = getOrCreateXmtpDbEncryptionKey();
  expect(key.length).toBe(32);
  expect(mockSetShared).toHaveBeenCalledWith('xmtp.dbEncryptionKey', expect.any(String));
});
