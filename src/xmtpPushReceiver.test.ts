import { decryptPushedMessage, type ReceiverDeps } from './xmtpPushReceiver';

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
