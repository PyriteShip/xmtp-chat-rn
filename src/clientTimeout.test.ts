// Client creation can hang — a wallet signature nobody answers, a network call
// that never returns — and creation is single-flighted per address, so a hung
// attempt would be handed to every later caller and retry forever. These cases
// pin that an attempt is bounded by `clientCreateTimeoutMs`, that a timeout
// frees the next call to start fresh, and that an abandoned attempt settling
// late never clobbers an attempt that superseded it.
import { Client } from '@xmtp/react-native-sdk';
import { configureXmtpChat } from './configure';
import {
  XmtpClientCreateTimeoutError,
  dropXmtpClient,
  getActiveXmtpClient,
  getOrCreateXmtpClient,
  getXmtpClientStatus,
  isXmtpClientCreateTimeoutError,
  onXmtpClientReady,
  retryXmtpClient,
} from './client';

const create = Client.create as jest.Mock;
const client = (installationId: string) => ({ installationId });
const identity = { address: '0xABC', signer: { tag: 'signer' } as any };

/** A create call the test settles by hand. */
function deferred() {
  let resolve!: (c: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets pending promise continuations run. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], clientCreateTimeoutMs: 1_000 });
  await dropXmtpClient();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a hung create rejects with a timeout error at the deadline', async () => {
  create.mockReturnValueOnce(new Promise(() => {}));
  const pending = getOrCreateXmtpClient(identity);
  const outcome = pending.then(() => 'resolved', (e) => e);

  jest.advanceTimersByTime(999);
  await flush();
  expect(getXmtpClientStatus()).toEqual({ state: 'initializing', address: '0xabc' });

  jest.advanceTimersByTime(1);
  const err = await outcome;
  expect(err).toBeInstanceOf(XmtpClientCreateTimeoutError);
  expect(isXmtpClientCreateTimeoutError(err)).toBe(true);
  expect(err.timeoutMs).toBe(1_000);
  expect(getXmtpClientStatus()).toEqual({
    state: 'failed', address: '0xabc', error: err.message,
  });
});

test('after a timeout the next call starts a fresh create instead of rejoining the hung one', async () => {
  create.mockReturnValueOnce(new Promise(() => {}));
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;

  create.mockResolvedValueOnce(client('inst-2'));
  await expect(retryXmtpClient()).resolves.toEqual(client('inst-2'));
  expect(create).toHaveBeenCalledTimes(2);
  expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', address: '0xabc' });
});

test('a stale attempt resolving after a newer attempt succeeded leaves the newer client in place', async () => {
  const ready = jest.fn();
  const unsubscribe = onXmtpClientReady(ready);
  const stale = deferred();
  create.mockReturnValueOnce(stale.promise);
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;

  create.mockResolvedValueOnce(client('inst-new'));
  await getOrCreateXmtpClient(identity);

  stale.resolve(client('inst-stale'));
  await flush();

  expect(getActiveXmtpClient()).toEqual(client('inst-new'));
  expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', client: client('inst-new') });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(ready).toHaveBeenCalledWith(client('inst-new'), '0xabc');
  unsubscribe();
});

test('a stale attempt resolving while a newer attempt is still in flight is not adopted', async () => {
  const stale = deferred();
  create.mockReturnValueOnce(stale.promise);
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;

  const newer = deferred();
  create.mockReturnValueOnce(newer.promise);
  const second = getOrCreateXmtpClient(identity);

  stale.resolve(client('inst-stale'));
  await flush();
  expect(getActiveXmtpClient()).toBeNull();
  expect(getXmtpClientStatus()).toEqual({ state: 'initializing', address: '0xabc' });

  newer.resolve(client('inst-new'));
  await expect(second).resolves.toEqual(client('inst-new'));
  expect(getActiveXmtpClient()).toEqual(client('inst-new'));
});

test('a stale attempt failing late does not overwrite a newer attempt’s status', async () => {
  const stale = deferred();
  create.mockReturnValueOnce(stale.promise);
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;

  create.mockResolvedValueOnce(client('inst-new'));
  await getOrCreateXmtpClient(identity);

  stale.reject(new Error('late failure'));
  await flush();
  expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', client: client('inst-new') });
});

test('a timed-out attempt that later succeeds with no newer attempt is adopted, and announced once', async () => {
  const ready = jest.fn();
  const unsubscribe = onXmtpClientReady(ready);
  const late = deferred();
  create.mockReturnValueOnce(late.promise);
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;
  expect(getXmtpClientStatus()).toMatchObject({ state: 'failed' });

  late.resolve(client('inst-late'));
  await flush();

  expect(getActiveXmtpClient()).toEqual(client('inst-late'));
  expect(getXmtpClientStatus()).toMatchObject({ state: 'ready', address: '0xabc' });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(ready).toHaveBeenCalledWith(client('inst-late'), '0xabc');

  // Joining the adopted client neither re-creates nor re-announces it.
  await expect(getOrCreateXmtpClient(identity)).resolves.toEqual(client('inst-late'));
  await expect(retryXmtpClient()).resolves.toEqual(client('inst-late'));
  expect(create).toHaveBeenCalledTimes(1);
  expect(ready).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('a timed-out attempt that succeeds after sign-out is not adopted', async () => {
  const late = deferred();
  create.mockReturnValueOnce(late.promise);
  const first = getOrCreateXmtpClient(identity).catch((e) => e);
  jest.advanceTimersByTime(1_000);
  await first;
  await dropXmtpClient();

  late.resolve(client('inst-late'));
  await flush();
  expect(getActiveXmtpClient()).toBeNull();
  expect(getXmtpClientStatus()).toEqual({ state: 'idle' });
});

test('a create that settles in time clears its timer', async () => {
  create.mockResolvedValueOnce(client('inst-1'));
  await getOrCreateXmtpClient(identity);
  expect(jest.getTimerCount()).toBe(0);
});

test('null disables the timeout', async () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], clientCreateTimeoutMs: null });
  const slow = deferred();
  create.mockReturnValueOnce(slow.promise);
  const pending = getOrCreateXmtpClient(identity);
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(10 * 60_000);
  await flush();
  expect(getXmtpClientStatus()).toEqual({ state: 'initializing', address: '0xabc' });
  slow.resolve(client('inst-1'));
  await expect(pending).resolves.toEqual(client('inst-1'));
});

test('defaults to 60 seconds when unset', async () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  create.mockReturnValueOnce(new Promise(() => {}));
  const outcome = getOrCreateXmtpClient(identity).then(() => 'resolved', (e) => e);
  jest.advanceTimersByTime(59_999);
  await flush();
  expect(getXmtpClientStatus()).toMatchObject({ state: 'initializing' });
  jest.advanceTimersByTime(1);
  const err = await outcome;
  expect(isXmtpClientCreateTimeoutError(err)).toBe(true);
  expect(err.timeoutMs).toBe(60_000);
});
