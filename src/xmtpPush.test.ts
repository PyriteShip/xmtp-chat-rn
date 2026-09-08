// The reachability gate exists because the native XMTPPush call runs on the
// shared XMTP runtime: against a port with no route it hangs and wedges the
// whole client, so the Inbox stops syncing. A probe timeout must therefore read
// as UNREACHABLE, while any answer at all — including a protocol error from a
// gRPC port that does not speak HTTP — reads as reachable.
import { configureXmtpPush, isPushServerReachable, __resetPushProbe } from './xmtpPush';

beforeEach(() => {
  __resetPushProbe();
  configureXmtpPush({ serverUrl: 'host:8080', probeUrl: 'http://host:8080/' });
});

test('a probe timeout means unreachable', async () => {
  global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
  await expect(isPushServerReachable()).resolves.toBe(false);
});

test('a protocol error still means reachable — the port answered', async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error('Network request failed'));
  await expect(isPushServerReachable()).resolves.toBe(true);
});

test('an HTTP response means reachable', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true } as any);
  await expect(isPushServerReachable()).resolves.toBe(true);
});

test('the probe is memoised for the session', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true } as any);
  global.fetch = fetchMock;
  await isPushServerReachable();
  await isPushServerReachable();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
