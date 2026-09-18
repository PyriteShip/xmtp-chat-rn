// toChatMessage (private to useConversation.ts) is exercised black-box here,
// through the hook itself, rather than exported as a test seam: it decides
// what a decoded message becomes in `messages`, and that behavior is the
// actual contract worth pinning.
//
// Only the content-type dispatch this file cares about is covered — a
// message this package doesn't yet know how to render must produce its
// wire fallback as a text bubble, never silently vanish.
import { renderHook, waitFor } from '@testing-library/react-native';
import { configureXmtpChat } from './configure';
import { useConversation } from './useConversation';

const mockGetActiveXmtpClient = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => mockGetActiveXmtpClient(),
  isXmtpClientInitializing: () => false,
  subscribeXmtpClient: () => () => {},
}));

beforeEach(() => {
  jest.clearAllMocks();
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
});

function multiRemoteAttachmentMessage(fallback?: string) {
  return {
    id: 'm1',
    senderInboxId: 'peer-inbox',
    sentNs: 1_000,
    contentTypeId: 'xmtp.org/multiRemoteStaticAttachment:1.0',
    // Rendering the individual files is out of scope, so this content type's
    // payload is never actually decoded by this package.
    content: () => { throw new Error('not decoded'); },
    fallback,
    childMessages: [],
  };
}

function mockDmWithHistory(message: unknown) {
  return {
    id: 'dm-1',
    sync: jest.fn().mockResolvedValue(undefined),
    messagesWithReactions: jest.fn().mockResolvedValue([message]),
    messages: jest.fn().mockResolvedValue([message]),
    streamMessages: jest.fn().mockResolvedValue(() => {}),
  };
}

test('a multi remote attachment becomes a text bubble carrying its wire fallback', async () => {
  const dm = mockDmWithHistory(multiRemoteAttachmentMessage('Sent 3 files'));
  const client = {
    inboxId: 'my-inbox',
    canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
    conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);

  const { result } = renderHook(() => useConversation('0xpeer'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.messages).toEqual([
    expect.objectContaining({ kind: 'text', text: 'Sent 3 files' }),
  ]);
});

test('a multi remote attachment with no wire fallback is dropped, not shown blank', async () => {
  const dm = mockDmWithHistory(multiRemoteAttachmentMessage(undefined));
  const client = {
    inboxId: 'my-inbox',
    canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
    conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
  };
  mockGetActiveXmtpClient.mockReturnValue(client);

  const { result } = renderHook(() => useConversation('0xpeer'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.messages).toEqual([]);
});
