import { renderHook, waitFor, act } from '@testing-library/react-native';
import { configureXmtpChat } from './configure';
import { useGroup } from './useGroup';
import { getLastReadNs } from './readState';

const mockGetActiveXmtpClient = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => mockGetActiveXmtpClient(),
  isXmtpClientInitializing: () => false,
  subscribeXmtpClient: () => () => {},
}));

beforeEach(() => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], readReceipts: true });
});

function text(id: string, sender: string, body: string, sentNs: number, childMessages: unknown[] = []) {
  return { id, senderInboxId: sender, sentNs, contentTypeId: 'xmtp.org/text:1.0',
    content: () => body, fallback: undefined, childMessages };
}

function reaction(id: string, sender: string, reference: string, emoji: string, sentNs: number) {
  return { id, senderInboxId: sender, sentNs, contentTypeId: 'xmtp.org/reaction:2.0',
    content: () => ({ reference, action: 'added', schema: 'unicode', content: emoji }),
    fallback: undefined, childMessages: [] };
}

function readReceipt(id: string, sender: string, sentNs: number) {
  return { id, senderInboxId: sender, sentNs, contentTypeId: 'xmtp.org/readReceipt:1.0',
    content: () => ({}), fallback: undefined, childMessages: [] };
}

function setup(groupId: string, history: unknown[], group: Record<string, unknown> = {}) {
  let onMessage: ((m: unknown) => Promise<void>) | null = null;
  const g = {
    id: groupId,
    groupName: 'Climbers',
    groupImageUrl: 'https://img/c.png',
    sync: jest.fn().mockResolvedValue(undefined),
    messagesWithReactions: jest.fn().mockResolvedValue(history),
    messages: jest.fn().mockResolvedValue(history),
    streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
    send: jest.fn(),
    ...group,
  };
  const client = {
    inboxId: 'my-inbox',
    conversations: { findGroup: jest.fn().mockResolvedValue(g) },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);
  return { group: g, client, stream: (m: unknown) => onMessage!(m) };
}

test('loads group history newest-first, each message carrying its sender', async () => {
  setup('g-1', [text('a', 'alice', 'hi', 1), text('b', 'bob', 'yo', 2), text('c', 'my-inbox', 'hey', 3)]);
  const { result } = renderHook(() => useGroup('g-1'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.messages).toEqual([
    expect.objectContaining({ id: 'c', fromMe: true, text: 'hey' }),
    expect.objectContaining({ id: 'b', senderInboxId: 'bob', fromMe: false, text: 'yo' }),
    expect.objectContaining({ id: 'a', senderInboxId: 'alice', fromMe: false, text: 'hi' }),
  ]);
  expect(result.current.name).toBe('Climbers');
  expect(result.current.imageUrl).toBe('https://img/c.png');
  expect(result.current.notFound).toBe(false);
});

test('an unknown group id reports notFound instead of an empty thread', async () => {
  setup('g-x', []);
  mockGetActiveXmtpClient.mockReturnValue({
    inboxId: 'my-inbox',
    conversations: { findGroup: jest.fn().mockResolvedValue(undefined) },
  });
  const { result } = renderHook(() => useGroup('g-x'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.notFound).toBe(true);
  expect(result.current.messages).toEqual([]);
});

test('reactions from several members fold onto the message they target', async () => {
  setup('g-2', [
    text('a', 'alice', 'summit!', 1, [
      reaction('r1', 'bob', 'a', '🔥', 2),
      reaction('r2', 'my-inbox', 'a', '👍', 3),
    ]),
  ]);
  const { result } = renderHook(() => useGroup('g-2'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.reactions.get('a')).toHaveLength(2);
});

test('opening marks the group read locally but never sends anything', async () => {
  const { group } = setup('g-3', [text('a', 'alice', 'hi', 42)]);
  const { result } = renderHook(() => useGroup('g-3'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(getLastReadNs('g-3')).toBe(42);
  expect(group.send).not.toHaveBeenCalled();
});

test('a streamed message joins the thread and advances the read watermark', async () => {
  const { group, stream } = setup('g-4', [text('a', 'alice', 'hi', 1)]);
  const { result } = renderHook(() => useGroup('g-4'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  await act(async () => { await stream(text('b', 'bob', 'late', 7)); });
  expect(result.current.messages[0]).toEqual(expect.objectContaining({ id: 'b', text: 'late' }));
  expect(getLastReadNs('g-4')).toBe(7);
  expect(group.send).not.toHaveBeenCalled();
});

test('read receipts never mark my group messages read', async () => {
  const { stream } = setup('g-5', [text('a', 'my-inbox', 'mine', 1), readReceipt('rr', 'alice', 2)]);
  const { result } = renderHook(() => useGroup('g-5'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.messages).toEqual([expect.objectContaining({ id: 'a' })]);
  expect(result.current.messages[0]).not.toHaveProperty('delivery');

  await act(async () => { await stream(readReceipt('rr2', 'bob', 3)); });
  expect(result.current.messages).toHaveLength(1);
  expect(result.current.messages[0]).not.toHaveProperty('delivery');
});

describe('sending', () => {
  function sendableSetup(groupId: string, history: unknown[] = []) {
    const s = setup(groupId, history);
    s.group.send = jest.fn();
    (s.group as any).sendWithStatus = jest.fn().mockResolvedValue({ id: 'net-1', status: 'published' });
    return s;
  }

  test('send shows an optimistic bubble that the echo replaces', async () => {
    const { group, stream } = sendableSetup('g-s1');
    const { result } = renderHook(() => useGroup('g-s1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.send('hello all'); });
    expect((group as any).sendWithStatus).toHaveBeenCalledWith('hello all');
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'net-1', text: 'hello all', fromMe: true })]);

    await act(async () => { await stream(text('net-1', 'my-inbox', 'hello all', 9)); });
    expect(result.current.messages).toHaveLength(1);
  });

  test('a reply goes out as the XMTP reply type', async () => {
    const { group } = sendableSetup('g-s2', [text('a', 'alice', 'hi', 1)]);
    const { result } = renderHook(() => useGroup('g-s2'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('back', 'a'); });
    expect((group as any).sendWithStatus).toHaveBeenCalledWith({ reply: { reference: 'a', content: { text: 'back' } } });
  });

  test('a failed send leaves a failed bubble that retry sends again', async () => {
    const { group } = sendableSetup('g-s3');
    (group as any).sendWithStatus
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ id: 'net-2', status: 'published' });
    const { result } = renderHook(() => useGroup('g-s3'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.send('try me'); });
    const failed = result.current.messages[0];
    expect(failed).toEqual(expect.objectContaining({ delivery: 'failed' }));

    await act(async () => { await result.current.retryMessage(failed); });
    expect((group as any).sendWithStatus).toHaveBeenCalledTimes(2);
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'net-2', text: 'try me' })]);
  });

  test('toggleReaction sends a reaction and shows my pill', async () => {
    const { group } = sendableSetup('g-s4', [text('a', 'alice', 'hi', 1)]);
    const { result } = renderHook(() => useGroup('g-s4'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.toggleReaction('a', '🔥'); });
    expect((group as any).sendWithStatus).toHaveBeenCalledWith(
      expect.objectContaining({ reactionV2: expect.objectContaining({ reference: 'a', content: '🔥', action: 'added' }) }),
    );
    expect(result.current.reactions.get('a')).toEqual([expect.objectContaining({ senderInboxId: 'my-inbox', emoji: '🔥' })]);
  });

  test('reading a group with receipts enabled still sends no receipt', async () => {
    const { group, stream } = sendableSetup('g-s5', [text('a', 'alice', 'hi', 1)]);
    const { result } = renderHook(() => useGroup('g-s5'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await stream(text('b', 'bob', 'yo', 2)); });
    expect(group.send).not.toHaveBeenCalled();
    expect((group as any).sendWithStatus).not.toHaveBeenCalled();
  });

  test('send on an unknown group fails the bubble instead of throwing', async () => {
    mockGetActiveXmtpClient.mockReturnValue({
      inboxId: 'my-inbox',
      conversations: { findGroup: jest.fn().mockResolvedValue(undefined) },
    });
    const { result } = renderHook(() => useGroup('g-none'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('anyone?'); });
    expect(result.current.messages).toEqual([expect.objectContaining({ delivery: 'failed' })]);
  });
});

describe('group info', () => {
  const memberRow = (inboxId: string, addr: string, permissionLevel = 'member') =>
    ({ inboxId, identities: [{ kind: 'ETHEREUM', identifier: addr }], permissionLevel });

  test('exposes members with addresses and roles', async () => {
    setup('g-i1', [], {
      members: jest.fn().mockResolvedValue([memberRow('my-inbox', '0xME', 'super_admin'), memberRow('alice', '0xAL')]),
    });
    const { result } = renderHook(() => useGroup('g-i1'));
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(result.current.members[1]).toEqual({ inboxId: 'alice', address: '0xal', role: 'member', isMe: false });
  });

  test('a group_updated message re-reads name and members, and never becomes a bubble', async () => {
    const members = jest.fn()
      .mockResolvedValueOnce([memberRow('my-inbox', '0xME')])
      .mockResolvedValue([memberRow('my-inbox', '0xME'), memberRow('bob', '0xBO')]);
    const name = jest.fn().mockResolvedValue('Renamed');
    const imageUrl = jest.fn().mockResolvedValue('https://img/new.png');
    const { stream } = setup('g-i2', [], { members, name, imageUrl });
    const { result } = renderHook(() => useGroup('g-i2'));
    await waitFor(() => expect(result.current.members).toHaveLength(1));

    await act(async () => {
      await stream({ id: 'u1', senderInboxId: 'alice', sentNs: 5, contentTypeId: 'xmtp.org/group_updated:1.0',
        content: () => ({}), fallback: undefined, childMessages: [] });
    });
    await waitFor(() => expect(result.current.members).toHaveLength(2));
    expect(result.current.name).toBe('Renamed');
    expect(result.current.imageUrl).toBe('https://img/new.png');
    expect(result.current.messages).toEqual([]);
  });
});
