// Client creation is one signature-bearing async step that fails for reasons
// outside the host — a network drop, a stalled or declined signature, the
// installation cap. These cases pin that a failure is observable, recoverable
// without the host re-supplying the identity, and that wiring hung off
// readiness re-runs when a retry succeeds.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import {
  dropXmtpClient,
  getOrCreateXmtpClient,
  getXmtpClientStatus,
  onXmtpClientReady,
  retryXmtpClient,
} from './client';

const create = Client.create as jest.Mock;
const client = (installationId: string) => ({ installationId });
const identity = { address: '0xABC', signer: { tag: 'signer' } as any };

beforeEach(async () => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await dropXmtpClient();
});

describe('getXmtpClientStatus', () => {
  test('is idle before any client is requested', () => {
    expect(getXmtpClientStatus()).toEqual({ state: 'idle' });
  });

  test('is initializing while creation is in flight, then ready', async () => {
    let resolve!: (c: unknown) => void;
    create.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const pending = getOrCreateXmtpClient(identity);
    expect(getXmtpClientStatus()).toEqual({ state: 'initializing', address: '0xabc' });
    resolve(client('inst-1'));
    await pending;
    expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', address: '0xabc' });
  });

  test('is failed with the reason once creation rejects', async () => {
    create.mockRejectedValueOnce(new Error('signature declined'));
    await expect(getOrCreateXmtpClient(identity)).rejects.toThrow('signature declined');
    expect(getXmtpClientStatus()).toEqual({
      state: 'failed', address: '0xabc', error: 'signature declined',
    });
  });

  test('returns the same object until something changes', async () => {
    // useSyncExternalStore re-renders forever on a fresh snapshot per read.
    expect(getXmtpClientStatus()).toBe(getXmtpClientStatus());
    create.mockRejectedValueOnce(new Error('boom'));
    await getOrCreateXmtpClient(identity).catch(() => {});
    expect(getXmtpClientStatus()).toBe(getXmtpClientStatus());
  });

  test('a sign-out after a failure returns to idle', async () => {
    create.mockRejectedValueOnce(new Error('boom'));
    await getOrCreateXmtpClient(identity).catch(() => {});
    await dropXmtpClient();
    expect(getXmtpClientStatus()).toEqual({ state: 'idle' });
  });
});

describe('retryXmtpClient', () => {
  test('re-runs creation with the identity that failed', async () => {
    create
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(client('inst-2'));
    await getOrCreateXmtpClient(identity).catch(() => {});

    await expect(retryXmtpClient()).resolves.toEqual(client('inst-2'));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toBe(identity.signer);
    expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', address: '0xabc' });
  });

  test('resolves null rather than rejecting when the retry fails too', async () => {
    create
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    await getOrCreateXmtpClient(identity).catch(() => {});

    await expect(retryXmtpClient()).resolves.toBeNull();
    expect(getXmtpClientStatus()).toEqual({ state: 'failed', address: '0xabc', error: 'second' });
  });

  test('does nothing when no client was ever requested', async () => {
    await expect(retryXmtpClient()).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test('does nothing after a sign-out', async () => {
    create.mockRejectedValueOnce(new Error('boom'));
    await getOrCreateXmtpClient(identity).catch(() => {});
    await dropXmtpClient();
    await expect(retryXmtpClient()).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('returns the live client without re-creating it', async () => {
    create.mockResolvedValueOnce(client('inst-1'));
    await getOrCreateXmtpClient(identity);
    await expect(retryXmtpClient()).resolves.toEqual(client('inst-1'));
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('concurrent retries share one creation', async () => {
    create.mockRejectedValueOnce(new Error('boom'));
    await getOrCreateXmtpClient(identity).catch(() => {});
    create.mockResolvedValueOnce(client('inst-2'));
    const [a, b] = await Promise.all([retryXmtpClient(), retryXmtpClient()]);
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('onXmtpClientReady', () => {
  test('fires for a client that comes up after a failed first attempt', async () => {
    // Regression target: a host that wires notifications by awaiting its own
    // create call never re-wires when some other surface's retry succeeds.
    const ready = jest.fn();
    const unsubscribe = onXmtpClientReady(ready);
    create
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(client('inst-2'));

    await getOrCreateXmtpClient(identity).catch(() => {});
    expect(ready).not.toHaveBeenCalled();

    await retryXmtpClient();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(client('inst-2'), '0xabc');
    unsubscribe();
  });

  test('does not fire again for callers that join an existing client', async () => {
    const ready = jest.fn();
    const unsubscribe = onXmtpClientReady(ready);
    create.mockResolvedValueOnce(client('inst-1'));
    await getOrCreateXmtpClient(identity);
    await getOrCreateXmtpClient(identity);
    await retryXmtpClient();
    expect(ready).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test('stops firing once unsubscribed', async () => {
    const ready = jest.fn();
    onXmtpClientReady(ready)();
    create.mockResolvedValueOnce(client('inst-1'));
    await getOrCreateXmtpClient(identity);
    expect(ready).not.toHaveBeenCalled();
  });
});
