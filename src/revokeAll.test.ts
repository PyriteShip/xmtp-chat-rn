import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import { revokeAllInstallations } from './client';

const identity = { address: '0xABC', signer: {} as any };

beforeEach(() => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', cards: [] } as any);
});

test('revokes every installation of the inbox, including this one', async () => {
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([
    { installations: [{ id: 'a', createdAt: 1 }, { id: 'b', createdAt: 2 }, { id: 'c', createdAt: 3 }] },
  ]);
  const n = await revokeAllInstallations(identity);
  expect(Client.getOrCreateInboxId).toHaveBeenCalledWith(expect.objectContaining({ identifier: '0xabc' }), 'dev');
  expect(Client.revokeInstallations).toHaveBeenCalledWith('dev', identity.signer, 'inbox-1', ['a', 'b', 'c']);
  expect(n).toBe(3);
});

test('an inbox with no installations revokes nothing and still resolves', async () => {
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([{ installations: [] }]);
  await expect(revokeAllInstallations(identity)).resolves.toBe(0);
  expect(Client.revokeInstallations).not.toHaveBeenCalled();
});

test('drops the active client afterwards', async () => {
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([{ installations: [{ id: 'a' }] }]);
  await revokeAllInstallations(identity);
  const { getActiveXmtpClient } = require('./client');
  expect(getActiveXmtpClient()).toBeNull();
});
