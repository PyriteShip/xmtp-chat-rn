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
  const group = { id: 'g-1', groupName: 'Climbers', groupImageUrl: 'https://img/c.png', lastMessage: text('bob-inbox', 'summit', 20) };
  const client = {
    inboxId: 'my-inbox',
    inboxStates: jest.fn().mockResolvedValue([
      { inboxId: 'peer-inbox', identities: [{ kind: 'ETHEREUM', identifier: '0xPEER' }] },
      { inboxId: 'bob-inbox', identities: [{ kind: 'ETHEREUM', identifier: '0xBOB' }] },
    ]),
    conversations: {
      syncAllConversations: jest.fn().mockResolvedValue(undefined),
      listDms: jest.fn().mockResolvedValue([dm]),
      listGroups: jest.fn().mockResolvedValue([group]),
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
  ]);
});

test('a group read past its last message is not unread', async () => {
  mockClient();
  markRead('g-1', 20);
  const { result } = renderHook(() => useConversations({ includeGroups: true }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.conversations[0]).toEqual(expect.objectContaining({ id: 'g-1', unread: false }));
});
