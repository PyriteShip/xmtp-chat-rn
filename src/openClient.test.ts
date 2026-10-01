// A wallet signs once per installation; after that the installation's own keys
// in the local database read, stream and send. These cases pin that a client
// comes up from that database with no signer, that a signer-holding caller is
// never stuck behind a signer-less open that failed, and that a sign-out in
// the middle starts nothing.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import {
  dropXmtpClient,
  getActiveXmtpClient,
  getOrCreateXmtpClient,
  getXmtpClientStatus,
  onXmtpClientReady,
  openXmtpClient,
  retryXmtpClient,
} from './client';

const create = Client.create as jest.Mock;
const build = Client.build as jest.Mock;
const client = (installationId: string) => ({ installationId });
const identity = { address: '0xABC', signer: { tag: 'signer' } as any };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  jest.clearAllMocks();
  create.mockReset();
  build.mockReset();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await dropXmtpClient();
});

describe('openXmtpClient', () => {
  test('builds from the local installation without a signer and announces readiness', async () => {
    build.mockResolvedValueOnce(client('inst-local'));
    const ready = jest.fn();
    const off = onXmtpClientReady(ready);

    const opened = await openXmtpClient('0xABC');
    off();

    expect(opened.installationId).toBe('inst-local');
    expect(create).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledTimes(1);
    const [publicIdentity, options] = build.mock.calls[0];
    expect(publicIdentity).toMatchObject({ identifier: '0xabc', kind: 'ETHEREUM' });
    expect(options).toMatchObject({ env: 'dev' });
    expect(options.codecs.length).toBeGreaterThan(0);
    expect(ready).toHaveBeenCalledWith(opened, '0xabc');
    expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', address: '0xabc' });
  });

  test('a second open for the same address joins the first', async () => {
    const d = deferred<unknown>();
    build.mockReturnValueOnce(d.promise);
    const a = openXmtpClient('0xabc');
    const b = openXmtpClient('0xABC');
    d.resolve(client('inst-local'));
    expect(await a).toBe(await b);
    expect(build).toHaveBeenCalledTimes(1);
  });

  test('fails, and says why, on a device with no registered installation', async () => {
    build.mockRejectedValueOnce(new Error('No signer passed but signer was required.'));
    await expect(openXmtpClient('0xabc')).rejects.toThrow('signer was required');
    expect(getXmtpClientStatus()).toEqual({
      state: 'failed', address: '0xabc', error: 'No signer passed but signer was required.',
      withoutSigner: true,
    });
    expect(getActiveXmtpClient()).toBeNull();
  });

  test('retrying a failed open opens again rather than asking for a signature', async () => {
    build.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(client('inst-local'));
    await openXmtpClient('0xabc').catch(() => {});
    const retried = await retryXmtpClient();
    expect(retried?.installationId).toBe('inst-local');
    expect(build).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('a signer arriving for a wallet that was opened without one', () => {
  test('joins the client already up — no second client, nothing signed', async () => {
    build.mockResolvedValueOnce(client('inst-local'));
    const opened = await openXmtpClient('0xabc');
    expect(await getOrCreateXmtpClient(identity)).toBe(opened);
    expect(create).not.toHaveBeenCalled();
  });

  test('creates after a failed open, since only a signer can register an installation', async () => {
    build.mockRejectedValueOnce(new Error('no installation'));
    create.mockResolvedValueOnce(client('inst-new'));
    await openXmtpClient('0xabc').catch(() => {});
    const created = await getOrCreateXmtpClient(identity);
    expect(created.installationId).toBe('inst-new');
    expect(create).toHaveBeenCalledWith(identity.signer, expect.anything());
  });

  test('joins an open still in flight and, when it fails, creates instead of inheriting the failure', async () => {
    const d = deferred<unknown>();
    build.mockReturnValueOnce(d.promise);
    create.mockResolvedValueOnce(client('inst-new'));
    const opening = openXmtpClient('0xabc');
    const joined = getOrCreateXmtpClient(identity);
    expect(create).not.toHaveBeenCalled();

    d.reject(new Error('no installation'));
    await expect(opening).rejects.toThrow('no installation');
    expect((await joined).installationId).toBe('inst-new');
    expect(getXmtpClientStatus()).toMatchObject({ state: 'ready' });
  });

  test('joins an open still in flight and takes its client when it succeeds', async () => {
    const d = deferred<unknown>();
    build.mockReturnValueOnce(d.promise);
    const opening = openXmtpClient('0xabc');
    const joined = getOrCreateXmtpClient(identity);
    d.resolve(client('inst-local'));
    expect(await joined).toBe(await opening);
    expect(create).not.toHaveBeenCalled();
  });

  test('a sign-out while the open is in flight starts no creation', async () => {
    // The failed open must not turn into a client for a wallet that has left.
    const d = deferred<unknown>();
    build.mockReturnValueOnce(d.promise);
    const opening = openXmtpClient('0xabc');
    const joined = getOrCreateXmtpClient(identity);
    await dropXmtpClient();
    d.reject(new Error('no installation'));
    await expect(opening).rejects.toThrow();
    await expect(joined).rejects.toThrow('no installation');
    expect(create).not.toHaveBeenCalled();
    expect(getXmtpClientStatus()).toEqual({ state: 'idle' });
  });

  test('a retry after the upgrade uses the signer', async () => {
    // The open succeeded and was later lost to a reset-style failure: what a
    // retry re-runs is the signer-holding identity, not the bare address.
    build.mockRejectedValueOnce(new Error('no installation'));
    create.mockRejectedValueOnce(new Error('signature declined')).mockResolvedValueOnce(client('inst-new'));
    await openXmtpClient('0xabc').catch(() => {});
    await getOrCreateXmtpClient(identity).catch(() => {});
    // A creation the wallet declined is an ordinary failure, not a signer-less one.
    expect(getXmtpClientStatus()).toEqual({ state: 'failed', address: '0xabc', error: 'signature declined' });
    const retried = await retryXmtpClient();
    expect(retried?.installationId).toBe('inst-new');
    expect(build).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

test('opening for a different address drops the previous wallet\'s client first', async () => {
  build.mockResolvedValueOnce(client('inst-a')).mockResolvedValueOnce(client('inst-b'));
  await openXmtpClient('0xaaa');
  const b = await openXmtpClient('0xbbb');
  expect(Client.dropClient).toHaveBeenCalledWith('inst-a');
  expect(getActiveXmtpClient()).toBe(b);
});
