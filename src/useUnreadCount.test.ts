import { renderHook, waitFor } from '@testing-library/react-native';
import { configureXmtpChat } from './configure';
import { useUnreadCount } from './useUnreadCount';

const mockGetActiveXmtpClient = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => mockGetActiveXmtpClient(),
  subscribeXmtpClient: () => () => {},
}));

beforeEach(() => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
});

function text(sender: string, sentNs: number) {
  return { id: `m-${sentNs}`, senderInboxId: sender, sentNs, contentTypeId: 'xmtp.org/text:1.0',
    content: () => 'hi', fallback: undefined, childMessages: [] };
}

function mockClient() {
  const client = {
    inboxId: 'my-inbox',
    conversations: {
      listDms: jest.fn().mockResolvedValue([{ id: 'dm-u', lastMessage: text('peer', 10) }]),
      listGroups: jest.fn().mockResolvedValue([{ id: 'g-u', lastMessage: text('bob', 20) }]),
    },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);
  return client;
}

test('counts unread DMs only by default', async () => {
  const client = mockClient();
  const { result } = renderHook(() => useUnreadCount());
  await waitFor(() => expect(result.current).toBe(1));
  expect(client.conversations.listGroups).not.toHaveBeenCalled();
});

test('includeGroups counts unread groups too', async () => {
  mockClient();
  const { result } = renderHook(() => useUnreadCount({ includeGroups: true }));
  await waitFor(() => expect(result.current).toBe(2));
});
