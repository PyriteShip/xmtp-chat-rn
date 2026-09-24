// The reachability gate exists because the native XMTPPush call runs on the
// shared XMTP runtime: against a port with no route it hangs and wedges the
// whole client, so the Inbox stops syncing. A probe timeout must therefore read
// as UNREACHABLE, while any answer at all — including a protocol error from a
// gRPC port that does not speak HTTP — reads as reachable.
import { configureXmtpPush, isPushServerReachable, subscribeConversationTopics, registerXmtpPush, __resetPushProbe } from './xmtpPush';
import { configureXmtpChat } from './configure';

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

// A host that never configured push must not reach the native subscribe:
// with no probe URL the fetch threw a TypeError, which read as "reachable",
// and the native layer then logged "Push server not registered" on every
// launch.
describe('when push is not wanted', () => {
  const client = () => ({ conversations: { list: jest.fn().mockResolvedValue([{ topic: 't1' }]) } }) as any;

  test('an unconfigured push server reads as unreachable without a fetch', async () => {
    global.fetch = jest.fn();
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('./xmtpPush');
      await expect(fresh.isPushServerReachable()).resolves.toBe(false);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('push: false skips topic subscription even with a reachable server', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as any);
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], push: false });
    const c = client();
    await subscribeConversationTopics(c);
    expect(c.conversations.list).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('push defaults on for a configured server', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as any);
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
    const c = client();
    await subscribeConversationTopics(c);
    expect(c.conversations.list).toHaveBeenCalled();
  });
});

// The "unreachable" warning is for a host that configured a server that did
// not answer. A host that never called configureXmtpPush has nothing
// unreachable, so it gets no warning.
describe('registerXmtpPush quiet-unconfigured', () => {
  test('does not warn when push was never configured', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn();
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('./xmtpPush');
      await fresh.registerXmtpPush({} as any, 'token-1');
    });
    expect(warnSpy).not.toHaveBeenCalledWith('[push] push server unreachable; skipping XMTP registration this session');
    expect(global.fetch).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('still warns when configured but the server is unreachable', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { name: 'AbortError' }));
    // Top-level beforeEach already called configureXmtpPush for this module.
    await registerXmtpPush({} as any, 'token-1');
    expect(warnSpy).toHaveBeenCalledWith('[push] push server unreachable; skipping XMTP registration this session');
    warnSpy.mockRestore();
  });
});

// Push defaults on, so a host that meant to use it but forgot
// configureXmtpPush would otherwise get no signal at all. Development builds
// get one console.info per session; release builds stay silent.
describe('development hint when push is wanted but not configured', () => {
  const g = global as unknown as { __DEV__?: boolean };
  afterEach(() => { delete g.__DEV__; });

  test('logs once per session in a development build', async () => {
    g.__DEV__ = true;
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    global.fetch = jest.fn();
    await jest.isolateModulesAsync(async () => {
      const { configureXmtpChat: configure } = await import('./configure');
      configure({ env: 'dev', enabled: true, cards: [] });
      const fresh = await import('./xmtpPush');
      const c = { conversations: { list: jest.fn().mockResolvedValue([]) } } as any;
      await fresh.registerXmtpPush(c, 'token-1');
      await fresh.subscribeConversationTopics(c);
      await fresh.registerXmtpPush(c, 'token-1');
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toContain('configureXmtpPush');
    infoSpy.mockRestore();
  });

  test('stays silent when the host turned push off', async () => {
    g.__DEV__ = true;
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await jest.isolateModulesAsync(async () => {
      const { configureXmtpChat: configure } = await import('./configure');
      configure({ env: 'dev', enabled: true, cards: [], push: false });
      const fresh = await import('./xmtpPush');
      await fresh.registerXmtpPush({} as any, 'token-1');
    });
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  test('stays silent in a release build', async () => {
    g.__DEV__ = false;
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await jest.isolateModulesAsync(async () => {
      const { configureXmtpChat: configure } = await import('./configure');
      configure({ env: 'dev', enabled: true, cards: [] });
      const fresh = await import('./xmtpPush');
      await fresh.registerXmtpPush({} as any, 'token-1');
    });
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });
});
