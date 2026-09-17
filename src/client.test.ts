// client.ts is a module singleton (one client per connected wallet, cached at
// module scope), so these cases pin exactly what broke on device: an inbox at
// XMTP's 10-installation cap after a `pm clear` reinstall, two concurrent
// sign-ins racing to create a client for the same address, and a sign-in that
// revoked the same wallet's installation on another physical device.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import { codecs, dropXmtpClient, getOrCreateXmtpClient } from './client';

/** A resolved client whose inbox/revoke surface is fully observable. */
function mockClient(installationId: string) {
  return {
    installationId,
    inboxState: jest.fn().mockResolvedValue({ installations: [] }),
    revokeAllOtherInstallations: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], devInstallationPrune: true });
  // client.ts's activeAddress/activeClient/initPromise persist across tests in
  // this file (module singleton) — drop whatever the previous test left behind
  // so every test starts from a known, client-less state.
  await dropXmtpClient();
});

test('a maxed-out inbox is recovered by revoking only its oldest installation and retrying create once', async () => {
  // Recorded device failure: after `pm clear`, the wiped local DB has no
  // current installation to preserve, but the inbox's prior installations are
  // still registered against XMTP's 10-per-inbox cap — so the first
  // Client.create after reinstall rejects with exactly this message.
  (Client.create as jest.Mock)
    .mockRejectedValueOnce(new Error('already registered 10/10 installations'))
    .mockResolvedValueOnce(mockClient('inst-fresh'));
  // Ten registered installations, listed out of creation order: the oldest
  // (createdAt 100) sits in the middle of the list, so revoking "the first
  // listed" would pick the wrong one. Any of the other nine may be a live
  // device — revoking it makes that device's sends silently undeliverable.
  const installations = [
    { id: 'inst-2019', createdAt: 900 },
    { id: 'inst-2021', createdAt: 300 },
    { id: 'inst-2022', createdAt: 500 },
    { id: 'inst-2023', createdAt: 700 },
    { id: 'inst-oldest', createdAt: 100 },
    { id: 'inst-2024', createdAt: 1_000 },
    { id: 'inst-2025', createdAt: 200 },
    { id: 'inst-2026', createdAt: 400 },
    { id: 'inst-2027', createdAt: 600 },
    { id: 'inst-2028', createdAt: 800 },
  ];
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([{ installations }]);

  const identity = { address: '0xABC', signer: {} as any };
  const client = await getOrCreateXmtpClient(identity);

  expect(client.installationId).toBe('inst-fresh');
  // Exactly one slot is needed, so exactly the single oldest installation is
  // revoked — by createdAt, not by list position.
  expect(Client.revokeInstallations).toHaveBeenCalledTimes(1);
  expect(Client.revokeInstallations).toHaveBeenCalledWith(
    'dev',
    identity.signer,
    'inbox-1',
    ['inst-oldest'],
  );
  // Exactly once recovered, exactly once retried — not a retry loop.
  expect(Client.create).toHaveBeenCalledTimes(2);
});

test('an inbox over the cap revokes only as many oldest installations as free one slot; unknown ages sort last', async () => {
  (Client.create as jest.Mock)
    .mockRejectedValueOnce(new Error('already registered 10/10 installations'))
    .mockResolvedValueOnce(mockClient('inst-fresh'));
  // Eleven registered: freeing one slot under a cap of ten means revoking two.
  // The installation with no createdAt cannot be shown to be old, so it is
  // never chosen ahead of one that can.
  const installations = [
    { id: 'inst-unknown-age', createdAt: undefined },
    { id: 'inst-k', createdAt: 1_100 },
    { id: 'inst-b', createdAt: 200 },
    { id: 'inst-c', createdAt: 300 },
    { id: 'inst-d', createdAt: 400 },
    { id: 'inst-e', createdAt: 500 },
    { id: 'inst-a', createdAt: 100 },
    { id: 'inst-f', createdAt: 600 },
    { id: 'inst-g', createdAt: 700 },
    { id: 'inst-h', createdAt: 800 },
    { id: 'inst-i', createdAt: 900 },
  ];
  (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([{ installations }]);

  const identity = { address: '0xABC', signer: {} as any };
  await getOrCreateXmtpClient(identity);

  expect(Client.revokeInstallations).toHaveBeenCalledWith(
    'dev',
    identity.signer,
    'inbox-1',
    ['inst-a', 'inst-b'],
  );
});

test('a successful sign-in never revokes installations, even with devInstallationPrune on', async () => {
  // Recorded device failure: a debug Android sign-in revoked the same wallet's
  // iPhone installation. The revoked device kept "sending" while every
  // recipient dropped its messages — silent, total loss. So a create that
  // succeeds must not touch the inbox's installation list at all, on any
  // configuration.
  const client = mockClient('inst-live');
  (Client.create as jest.Mock).mockResolvedValueOnce(client);

  await getOrCreateXmtpClient({ address: '0xABC', signer: {} as any });
  // Let any fire-and-forget work that a sign-in might schedule run to completion.
  await new Promise((r) => setImmediate(r));

  expect(client.inboxState).not.toHaveBeenCalled();
  expect(client.revokeAllOtherInstallations).not.toHaveBeenCalled();
  expect(Client.revokeInstallations).not.toHaveBeenCalled();
});

test('two concurrent calls for one address share a client; a different address drops it', async () => {
  const clientA = mockClient('inst-a');
  const clientB = mockClient('inst-b');
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

describe('codecs', () => {
  it('registers the read-receipt codec so receipts arrive decoded', () => {
    const { ReadReceiptCodec } = require('@xmtp/react-native-sdk');
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
    expect(codecs().some((c: any) => c instanceof ReadReceiptCodec)).toBe(true);
  });

  test('registers both attachment codecs so other clients\' attachments decode', () => {
    const { RemoteAttachmentCodec, StaticAttachmentCodec } = require('@xmtp/react-native-sdk');
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
    const registered = codecs();
    expect(registered.some((c: any) => c instanceof RemoteAttachmentCodec)).toBe(true);
    expect(registered.some((c: any) => c instanceof StaticAttachmentCodec)).toBe(true);
  });
});
