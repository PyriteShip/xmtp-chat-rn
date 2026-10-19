import { Client } from '@xmtp/react-native-sdk';
import { decryptPushedMessage, type ReceiverDeps } from './xmtpPushReceiver';
import { setActiveXmtpAddress, clearActiveXmtpAddress } from './activeAddress';
import { configureXmtpChat } from './configure';

const RESULT = { title: 'from alice', body: 'hi' };

function makeClient(opts: { conv?: any; installationId?: string } = {}) {
  return {
    installationId: opts.installationId ?? 'inst-1',
    conversations: { findConversationByTopic: jest.fn().mockResolvedValue(opts.conv) },
  } as any;
}
function deps(over: Partial<ReceiverDeps> = {}): ReceiverDeps {
  return {
    buildClient: jest.fn().mockResolvedValue(makeClient()),
    dropClient: jest.fn().mockResolvedValue(undefined),
    render: jest.fn().mockResolvedValue(RESULT),
    timeoutMs: 1000,
    ...over,
  };
}
const payload = { topic: 't', encryptedMessage: 'b64' };

it('builds, decrypts, renders, and drops the built client', async () => {
  const conv = { processMessage: jest.fn().mockResolvedValue({ id: 'm1' }) };
  const client = makeClient({ conv });
  const d = deps({ buildClient: jest.fn().mockResolvedValue(client) });
  await expect(decryptPushedMessage(payload, d)).resolves.toEqual(RESULT);
  expect(conv.processMessage).toHaveBeenCalledWith('b64');
  expect(d.render).toHaveBeenCalledWith({ id: 'm1' }, client);
  expect(d.dropClient).toHaveBeenCalledWith('inst-1');
});

it('reuses a live client and does NOT drop it', async () => {
  const conv = { processMessage: jest.fn().mockResolvedValue({ id: 'm1' }) };
  const live = makeClient({ conv, installationId: 'live' });
  const d = deps({ getActiveClient: () => live, buildClient: jest.fn() });
  await decryptPushedMessage(payload, d);
  expect(d.buildClient).not.toHaveBeenCalled();
  expect(d.dropClient).not.toHaveBeenCalled();
});

it('returns null when no client is available', async () => {
  const d = deps({ buildClient: jest.fn().mockResolvedValue(null) });
  await expect(decryptPushedMessage(payload, d)).resolves.toBeNull();
});

it('returns null when the conversation is not found, still drops', async () => {
  const client = makeClient({ conv: undefined });
  const d = deps({ buildClient: jest.fn().mockResolvedValue(client) });
  await expect(decryptPushedMessage(payload, d)).resolves.toBeNull();
  expect(d.dropClient).toHaveBeenCalled();
});

it('returns null when processMessage throws, still drops', async () => {
  const conv = { processMessage: jest.fn().mockRejectedValue(new Error('boom')) };
  const client = makeClient({ conv });
  const d = deps({ buildClient: jest.fn().mockResolvedValue(client) });
  await expect(decryptPushedMessage(payload, d)).resolves.toBeNull();
  expect(d.dropClient).toHaveBeenCalled();
});

it('returns null on timeout', async () => {
  const conv = { processMessage: () => new Promise(() => {}) };
  const client = makeClient({ conv });
  const d = deps({ buildClient: jest.fn().mockResolvedValue(client), timeoutMs: 20 });
  await expect(decryptPushedMessage(payload, d)).resolves.toBeNull();
});

describe('default client handling', () => {
  // The defaults let a host pass only `render`: the client is built for the
  // address recorded as active and released through the SDK afterwards.
  const build = Client.build as jest.Mock;
  const dropClient = Client.dropClient as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  });
  afterEach(() => clearActiveXmtpAddress());

  it('builds for the active address and drops the built client', async () => {
    const conv = { processMessage: jest.fn().mockResolvedValue({ id: 'm1' }) };
    build.mockResolvedValueOnce(makeClient({ conv, installationId: 'inst-9' }));
    setActiveXmtpAddress('0xABC');
    const render = jest.fn().mockResolvedValue(RESULT);

    await expect(decryptPushedMessage(payload, { render, timeoutMs: 1000 })).resolves.toEqual(RESULT);
    expect(build.mock.calls[0][0]).toMatchObject({ identifier: '0xabc', kind: 'ETHEREUM' });
    expect(dropClient).toHaveBeenCalledWith('inst-9');
  });

  it('returns null with no active address, building nothing', async () => {
    await expect(decryptPushedMessage(payload, { render: jest.fn(), timeoutMs: 1000 })).resolves.toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it('returns null when the build rejects', async () => {
    build.mockRejectedValueOnce(new Error('no installation'));
    setActiveXmtpAddress('0xabc');
    await expect(decryptPushedMessage(payload, { render: jest.fn(), timeoutMs: 1000 })).resolves.toBeNull();
  });
});
