// An inbox at XMTP's 10-installation cap cannot register this device until the
// user revokes one. These cases pin what a host needs to offer that choice:
// the failure is labelled, the installations are readable with no client, and
// a revocation touches exactly the installations named.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import {
  dropXmtpClient,
  getOrCreateXmtpClient,
  getXmtpClientStatus,
  isInstallationLimitError,
  listXmtpInstallations,
  revokeXmtpInstallations,
} from './client';

const create = Client.create as jest.Mock;
const identity = { address: '0xABC', signer: { tag: 'signer' } as any };
const CAP_ERROR =
  'Cannot register a new installation because the InboxID abc has already registered 10/10 installations. Please revoke existing installations first.';

beforeEach(async () => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await dropXmtpClient();
});

describe('isInstallationLimitError', () => {
  test('recognises the cap error, as an error or its message', () => {
    expect(isInstallationLimitError(new Error(CAP_ERROR))).toBe(true);
    expect(isInstallationLimitError(CAP_ERROR)).toBe(true);
  });

  test('does not match other failures', () => {
    expect(isInstallationLimitError(new Error('signature declined'))).toBe(false);
    expect(isInstallationLimitError(null)).toBe(false);
  });
});

describe('failed status at the cap', () => {
  test('carries installationLimit', async () => {
    create.mockRejectedValueOnce(new Error(CAP_ERROR));
    await getOrCreateXmtpClient(identity).catch(() => {});
    expect(getXmtpClientStatus()).toEqual({
      state: 'failed', address: '0xabc', error: CAP_ERROR, installationLimit: true,
    });
  });

  test('is absent for any other failure', async () => {
    create.mockRejectedValueOnce(new Error('signature declined'));
    await getOrCreateXmtpClient(identity).catch(() => {});
    expect(getXmtpClientStatus()).not.toHaveProperty('installationLimit');
  });
});

describe('listXmtpInstallations', () => {
  test('lists the inbox newest first, unknown ages last, with no client', async () => {
    (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([
      { installations: [{ id: 'a', createdAt: 1e12 }, { id: 'u' }, { id: 'c', createdAt: 3e12 }, { id: 'b', createdAt: 2e12 }] },
    ]);
    await expect(listXmtpInstallations('0xABC')).resolves.toEqual([
      { id: 'c', createdAt: 3e12, current: false },
      { id: 'b', createdAt: 2e12, current: false },
      { id: 'a', createdAt: 1e12, current: false },
      { id: 'u', current: false },
    ]);
    expect(Client.getOrCreateInboxId).toHaveBeenCalledWith(expect.objectContaining({ identifier: '0xabc' }), 'dev');
    expect(Client.create).not.toHaveBeenCalled();
  });

  // The SDK's iOS bridge reports seconds, its Android bridge milliseconds.
  test('reports createdAt in milliseconds from either platform', async () => {
    (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([
      { installations: [{ id: 'ios', createdAt: 1_790_106_182.6 }, { id: 'android', createdAt: 1_790_000_000_000 }] },
    ]);
    await expect(listXmtpInstallations('0xabc')).resolves.toEqual([
      { id: 'ios', createdAt: 1_790_106_182_600, current: false },
      { id: 'android', createdAt: 1_790_000_000_000, current: false },
    ]);
  });

  test("marks the active client's installation as current", async () => {
    create.mockResolvedValueOnce({ installationId: 'b' });
    await getOrCreateXmtpClient(identity);
    (Client.inboxStatesForInboxIds as jest.Mock).mockResolvedValueOnce([
      { installations: [{ id: 'a', createdAt: 1e12 }, { id: 'b', createdAt: 2e12 }] },
    ]);
    const list = await listXmtpInstallations('0xabc');
    expect(list.map((i) => [i.id, i.current])).toEqual([['b', true], ['a', false]]);
  });
});

describe('revokeXmtpInstallations', () => {
  test('revokes exactly the installations named', async () => {
    await expect(revokeXmtpInstallations(identity, ['a', 'c'])).resolves.toBe(2);
    expect(Client.revokeInstallations).toHaveBeenCalledWith('dev', identity.signer, 'inbox-1', ['a', 'c']);
  });

  test('an empty list asks nothing of the wallet', async () => {
    await expect(revokeXmtpInstallations(identity, [])).resolves.toBe(0);
    expect(Client.revokeInstallations).not.toHaveBeenCalled();
  });

  test("refuses the active client's own installation", async () => {
    create.mockResolvedValueOnce({ installationId: 'b' });
    await getOrCreateXmtpClient(identity);
    await expect(revokeXmtpInstallations(identity, ['a', 'b'])).rejects.toThrow(/active installation/);
    expect(Client.revokeInstallations).not.toHaveBeenCalled();
  });
});
