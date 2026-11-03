import { renderHook, waitFor } from '@testing-library/react-native';
import { configureXmtpChat } from './configure';
import { useConversations } from './useConversations';
import { markRead } from './readState';

const mockGetActiveXmtpClient = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => mockGetActiveXmtpClient(),
  isXmtpClientInitializing: () => false,
  subscribeXmtpClient: () => () => {},
}));
jest.mock('./xmtpPush', () => ({ subscribeConversationTopics: jest.fn().mockResolvedValue(undefined) }));

beforeEach(() => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
});

function text(sender: string, body: string, sentNs: number) {
  return { id: `m-${sentNs}`, senderInboxId: sender, sentNs, contentTypeId: 'xmtp.org/text:1.0',
    content: () => body, fallback: undefined, childMessages: [] };
}

function mockClient() {
  const dm = { id: 'dm-1', lastMessage: text('peer-inbox', 'hello', 10), peerInboxId: jest.fn().mockResolvedValue('peer-inbox') };
  const group = {
    id: 'g-1', groupName: 'Climbers', groupImageUrl: 'https://img/c.png', createdAt: 1_700_000_000_000,
    lastMessage: text('bob-inbox', 'summit', 20), appData: jest.fn().mockResolvedValue('app:climbers'),
  };
  const untagged = {
    id: 'g-2', groupName: 'Spam', groupImageUrl: '', createdAt: 1_700_000_000_001,
    lastMessage: text('bob-inbox', 'buy now', 5), appData: jest.fn().mockResolvedValue(''),
  };
  const client = {
    inboxId: 'my-inbox',
    inboxStates: jest.fn().mockResolvedValue([
      { inboxId: 'peer-inbox', identities: [{ kind: 'ETHEREUM', identifier: '0xPEER' }] },
      { inboxId: 'bob-inbox', identities: [{ kind: 'ETHEREUM', identifier: '0xBOB' }] },
    ]),
    conversations: {
      syncAllConversations: jest.fn().mockResolvedValue(undefined),
      listDms: jest.fn().mockResolvedValue([dm]),
      listGroups: jest.fn().mockResolvedValue([group, untagged]),
    },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);
  return client;
}

test('without includeGroups the inbox lists DMs only, exactly as before', async () => {
  const client = mockClient();
  const { result } = renderHook(() => useConversations());
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(client.conversations.listGroups).not.toHaveBeenCalled();
  expect(result.current.conversations).toEqual([
    expect.objectContaining({ id: 'dm-1', kind: 'dm', peerAddress: '0xpeer' }),
  ]);
});

test('includeGroups merges groups into the inbox, newest activity first', async () => {
  mockClient();
  const { result } = renderHook(() => useConversations({ includeGroups: true }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.conversations).toEqual([
    expect.objectContaining({
      id: 'g-1', kind: 'group', name: 'Climbers', imageUrl: 'https://img/c.png',
      lastSenderAddress: '0xbob', unread: true,
    }),
    expect.objectContaining({ id: 'dm-1', kind: 'dm', peerAddress: '0xpeer' }),
    expect.objectContaining({ id: 'g-2', kind: 'group' }),
  ]);
});

test('a group read past its last message is not unread', async () => {
  mockClient();
  markRead('g-1', 20);
  const { result } = renderHook(() => useConversations({ includeGroups: true }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.conversations[0]).toEqual(expect.objectContaining({ id: 'g-1', unread: false }));
});

test('group summaries carry the group\'s app data and creation time', async () => {
  mockClient();
  const { result } = renderHook(() => useConversations({ includeGroups: true }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.conversations).toContainEqual(
    expect.objectContaining({ id: 'g-1', kind: 'group', appData: 'app:climbers', createdAt: 1_700_000_000_000 }),
  );
});

test('a group filter lists only the groups it accepts, DMs untouched', async () => {
  mockClient();
  const { result } = renderHook(() =>
    useConversations({ includeGroups: (g) => g.appData.startsWith('app:') }),
  );
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.conversations.map((c) => c.id)).toEqual(['g-1', 'dm-1']);
});
