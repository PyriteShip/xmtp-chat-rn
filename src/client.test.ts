// client.ts is a module singleton (one client per connected wallet, cached at
// module scope), so these two cases pin exactly what broke on device: an
// inbox at XMTP's 10-installation cap after a `pm clear` reinstall, and two
// concurrent sign-ins racing to create a client for the same address.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import { dropXmtpClient, getOrCreateXmtpClient } from './client';

beforeEach(async () => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], devInstallationPrune: true });
  // client.ts's activeAddress/activeClient/initPromise persist across tests in
  // this file (module singleton) — drop whatever the previous test left behind
  // so every test starts from a known, client-less state.
  await dropXmtpClient();
});

test('a maxed-out inbox is recovered by revoking its orphaned installations and retrying create once', async () => {
  // Recorded device failure: after `pm clear`, the wiped local DB has no
  // current installation to preserve, but the inbox's prior installations are
  // still registered against XMTP's 10-per-inbox cap — so the first
  // Client.create after reinstall rejects with exactly this message.
  (Client.create as jest.Mock)
    .mockRejectedValueOnce(new Error('already registered 10/10 installations'))
    .mockResolvedValueOnce({
      installationId: 'inst-fresh',
      inboxState: jest.fn().mockResolvedValue({ installations: [] }),
    });
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([
    { installations: [{ id: 'orphan-1' }, { id: 'orphan-2' }] },
  ]);

  const identity = { address: '0xABC', signer: {} as any };
  const client = await getOrCreateXmtpClient(identity);

  expect(client.installationId).toBe('inst-fresh');
  // The orphans found via inboxStatesForInboxIds are the ones revoked, freeing
  // the slots the retry needs.
  expect(Client.revokeInstallations).toHaveBeenCalledWith(
    'dev',
    identity.signer,
    'inbox-1',
    ['orphan-1', 'orphan-2'],
  );
  // Exactly once recovered, exactly once retried — not a retry loop.
  expect(Client.create).toHaveBeenCalledTimes(2);
});

test('two concurrent calls for one address share a client; a different address drops it', async () => {
  const clientA = { installationId: 'inst-a', inboxState: jest.fn().mockResolvedValue({ installations: [] }) };
  const clientB = { installationId: 'inst-b', inboxState: jest.fn().mockResolvedValue({ installations: [] }) };
  (Client.create as jest.Mock).mockResolvedValueOnce(clientA).mockResolvedValueOnce(clientB);

  // Two concurrent sign-ins for the same address must not each register a new
  // installation — that burns two of XMTP's ten per-inbox slots for one wallet.
  const identityA = { address: '0xAAA', signer: {} as any };
  const [c1, c2] = await Promise.all([
    getOrCreateXmtpClient(identityA),
    getOrCreateXmtpClient(identityA),
  ]);
  expect(c1).toBe(c2);
  expect(Client.create).toHaveBeenCalledTimes(1);

  // A call for a different address is a wallet switch, not a race — the old
  // client is dropped (freeing its installation locally) before a new one is
  // created for the new address.
  const identityB = { address: '0xBBB', signer: {} as any };
  const c3 = await getOrCreateXmtpClient(identityB);
  expect(c3).toBe(clientB);
  expect(Client.dropClient).toHaveBeenCalledWith('inst-a');
});
