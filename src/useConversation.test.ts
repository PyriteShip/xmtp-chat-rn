// toChatMessage (private to useConversation.ts) is exercised black-box here,
// through the hook itself, rather than exported as a test seam: it decides
// what a decoded message becomes in `messages`, and that behavior is the
// actual contract worth pinning.
//
// Only the content-type dispatch this file cares about is covered — a
// message this package doesn't yet know how to render must produce its
// wire fallback as a text bubble, never silently vanish.
import { renderHook, waitFor, act } from '@testing-library/react-native';
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

function myText(id: string, text: string, sentNs: number, deliveryStatus?: string) {
  return { id, senderInboxId: 'my-inbox', sentNs, contentTypeId: 'xmtp.org/text:1.0',
    content: () => text, fallback: undefined, childMessages: [], deliveryStatus };
}

describe('publish that is still pending', () => {
  function setup(history: unknown[], dmId: string) {
    let onMessage: ((m: unknown) => Promise<void>) | null = null;
    const dm = {
      id: dmId,
      sync: jest.fn().mockResolvedValue(undefined),
      messagesWithReactions: jest.fn().mockResolvedValue(history),
      messages: jest.fn(),
      streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
      send: jest.fn(),
      sendWithStatus: jest.fn().mockResolvedValue({ id: 'm9', status: 'queued' }),
    };
    const client = {
      inboxId: 'my-inbox',
      canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
      conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
    };
    mockGetActiveXmtpClient.mockReturnValue(client);
    return { dm, echo: (m: unknown) => onMessage!(m) };
  }

  // The echo of a queued send must replace its bubble, never add a second one.
  test('a queued send becomes the echoed message', async () => {
    const { dm, echo } = setup([], 'dm-q1');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(dm.sendWithStatus).toHaveBeenCalledWith('hi');
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'm9', delivery: 'unpublished' })]);
    await act(async () => { await echo(myText('m9', 'hi', 5)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('history shows my stored-but-unpublished message as unpublished', async () => {
    setup([myText('m7', 'waiting', 3, 'UNPUBLISHED'), myText('m6', 'done', 2, 'PUBLISHED')], 'dm-q2');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages[0]).toMatchObject({ id: 'm7', delivery: 'unpublished' });
    expect(result.current.messages[1]).not.toHaveProperty('delivery');
  });
});

describe('send failure reconciliation: a rejected send keyed by its error messageId', () => {
  function setupFailing(send: jest.Mock, dmId: string) {
    let onMessage: ((m: unknown) => Promise<void>) | null = null;
    const dm = {
      id: dmId,
      sync: jest.fn().mockResolvedValue(undefined),
      messagesWithReactions: jest.fn().mockResolvedValue([]),
      messages: jest.fn(),
      streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
      send,
    };
    const client = {
      inboxId: 'my-inbox',
      canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
      conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
    };
    mockGetActiveXmtpClient.mockReturnValue(client);
    return { dm, echo: (m: unknown) => onMessage!(m) };
  }

  test('a rejected send whose error carries a string messageId keys the failed bubble by that id, so the echo reconciles by id', async () => {
    const err = Object.assign(new Error('publish failed'), { messageId: 'srv-1' });
    const send = jest.fn().mockRejectedValue(err);
    const { echo } = setupFailing(send, 'dm-f1');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-1', delivery: 'failed' })]);
    await act(async () => { await echo(myText('srv-1', 'hi', 5)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('two failed sends with identical text each key their own bubble by messageId, and each echo reconciles to the correct one', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('fail'), { messageId: 'srv-a' }))
      .mockRejectedValueOnce(Object.assign(new Error('fail'), { messageId: 'srv-b' }));
    const { echo } = setupFailing(send, 'dm-f2');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages.map((m: any) => m.id).sort()).toEqual(['srv-a', 'srv-b']);
    await act(async () => { await echo(myText('srv-a', 'hi', 5)); });
    await act(async () => { await echo(myText('srv-b', 'hi', 6)); });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.every((m: any) => !('delivery' in m))).toBe(true);
  });

  test('a rejected send without a messageId keeps the local id — reconciliation falls back to the text heuristic', async () => {
    const send = jest.fn().mockRejectedValue(new Error('no id here'));
    const { echo } = setupFailing(send, 'dm-f3');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages[0].id).toMatch(/^local-/);
    // An echo stands in for a failed copy by text only when sent close to it.
    await act(async () => { await echo(myText('srv-x', 'hi', result.current.messages[0].sentNs + 1e9)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });
});

function peerTextMessage(id: string, sentNs: number) {
  return {
    id, senderInboxId: 'peer-inbox', sentNs, contentTypeId: 'xmtp.org/text:1.0',
    content: () => 'hello', fallback: undefined, childMessages: [],
  };
}

function receiptTestClient(dmId: string) {
  const dm = {
    id: dmId,
    sync: jest.fn().mockResolvedValue(undefined),
    messagesWithReactions: jest.fn().mockResolvedValue([peerTextMessage('p1', 10)]),
    messages: jest.fn(),
    streamMessages: jest.fn().mockResolvedValue(() => {}),
    send: jest.fn().mockResolvedValue('r1'),
  };
  const client = {
    inboxId: 'my-inbox',
    canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
    conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
  };
  return { dm, client };
}

describe('per-thread read receipts', () => {
  // A receipt is a real send, and a send marks the conversation allowed — a
  // thread the host shows before the user accepts it must be able to opt out.
  test('per-thread readReceipts false sends nothing even when the host opted in', async () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], readReceipts: true });
    const { dm, client } = receiptTestClient('dm-rr-off');
    mockGetActiveXmtpClient.mockReturnValue(client);
    const { result } = renderHook(() => useConversation('0xpeer', undefined, { readReceipts: false }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(dm.send).not.toHaveBeenCalled();
  });

  test('without the option the host default applies', async () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], readReceipts: true });
    const { dm, client } = receiptTestClient('dm-rr-default');
    mockGetActiveXmtpClient.mockReturnValue(client);
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() =>
      expect(dm.send).toHaveBeenCalledWith({}, { contentType: expect.objectContaining({ typeId: 'readReceipt' }) }),
    );
  });
});

describe('retry and discard of a failed message the SDK stored', () => {
  function setupStored(
    dmExtra: Record<string, unknown>,
    dmId: string,
  ): { dm: any; echo: (m: unknown) => Promise<void> } {
    let onMessage: ((m: unknown) => Promise<void>) | null = null;
    const dm = {
      id: dmId,
      sync: jest.fn().mockResolvedValue(undefined),
      messagesWithReactions: jest.fn().mockResolvedValue([]),
      messages: jest.fn(),
      streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
      ...dmExtra,
    };
    const client = {
      inboxId: 'my-inbox',
      canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
      conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
    };
    mockGetActiveXmtpClient.mockReturnValue(client);
    return { dm, echo: (m: unknown) => onMessage!(m) };
  }

  test('a failed bubble with a stored id retries via publishPreparedMessages, keeps its id, and the echo reconciles', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('publish failed'), { messageId: 'srv-1' }));
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    const { echo } = setupStored({ send, publishPreparedMessages }, 'dm-r1');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-1', delivery: 'failed' })]);

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(publishPreparedMessages).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1); // no re-send / re-prepare — only the original failed attempt
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-1', delivery: 'sent' })]);

    await act(async () => { await echo(myText('srv-1', 'hi', 5)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('an echo that lands while the retry is publishing stays authoritative', async () => {
    // The SDK resolves publishPreparedMessages only after it syncs the message
    // back, which is also when the stream delivers the echo — so the echo
    // usually arrives before the retry finishes.
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('publish failed'), { messageId: 'srv-9' }));
    let echoNow: (m: unknown) => Promise<void> = async () => {};
    const publishPreparedMessages = jest.fn(async () => { await echoNow(myText('srv-9', 'hi', 5)); });
    const { echo } = setupStored({ send, publishPreparedMessages }, 'dm-r9');
    echoNow = echo;
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ id: 'srv-9', text: 'hi' });
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('a failed bubble with a stored id maps an unconfirmed-publish retry to unpublished, not failed', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('publish failed'), { messageId: 'srv-2' }));
    const publishPreparedMessages = jest.fn().mockRejectedValue(new Error('SyncFailedToWait: timed out'));
    setupStored({ send, publishPreparedMessages }, 'dm-r2');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(publishPreparedMessages).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-2', delivery: 'unpublished' })]);
  });

  test('on an SDK without publishPreparedMessages, retry falls back to the ordinary re-send path unchanged', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('publish failed'), { messageId: 'srv-3' }))
      .mockResolvedValueOnce('srv-3b');
    const { echo } = setupStored({ send }, 'dm-r3'); // no publishPreparedMessages at all
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages[0]).toMatchObject({ id: 'srv-3', delivery: 'failed' });

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-3b', delivery: 'sent' })]);
    await act(async () => { await echo(myText('srv-3b', 'hi', 6)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('discarding a failed bubble with a stored id is local only: nothing is deleted or sent', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('fail'), { messageId: 'srv-4' }));
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    setupStored({ send, deleteMessage, publishPreparedMessages }, 'dm-r4');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });

    act(() => { result.current.discardFailed('srv-4'); });

    // The SDK's deleteMessage sends a deletion message to the peer; it does not
    // cancel the stored copy, so calling it would deliver the discarded message.
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(publishPreparedMessages).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.messages).toHaveLength(0);
  });

  test('a discarded bubble with a stored id comes back if the SDK publishes it later', async () => {
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('fail'), { messageId: 'srv-5' }));
    const { echo } = setupStored({ send }, 'dm-r5');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });

    act(() => { result.current.discardFailed('srv-5'); });
    expect(result.current.messages).toHaveLength(0);

    await act(async () => { await echo(myText('srv-5', 'hi', 5)); });
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-5', text: 'hi' })]);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('discarding a failed bubble that never reached the SDK removes it', async () => {
    const send = jest.fn().mockRejectedValue(new Error('offline'));
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    setupStored({ send, deleteMessage }, 'dm-r6');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    const localId = result.current.messages[0].id;
    expect(localId).toMatch(/^local-/);

    act(() => { result.current.discardFailed(localId); });

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });
});

describe('attachment send failure reconciliation: keyed by id, same as text', () => {
  test('a rejected attachment send whose error carries a messageId keys the failed bubble by that id, so the echo reconciles by id', async () => {
    const mockEncrypt = jest.fn().mockResolvedValue({
      encryptedLocalFileUri: 'file:///tmp/enc',
      metadata: { secret: 's', salt: 'l', nonce: 'n', contentDigest: 'd1', contentLength: '100', filename: 'a.jpg' },
    });
    const upload = jest.fn().mockResolvedValue('https://files.example/d1');
    const download = jest.fn();
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], attachments: { upload, download } });

    let onMessage: ((m: unknown) => Promise<void>) | null = null;
    const send = jest.fn().mockRejectedValue(Object.assign(new Error('publish failed'), { messageId: 'srv-att-1' }));
    const dm = {
      id: 'dm-att-1',
      sync: jest.fn().mockResolvedValue(undefined),
      messagesWithReactions: jest.fn().mockResolvedValue([]),
      messages: jest.fn(),
      streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
      send,
    };
    const client = {
      inboxId: 'my-inbox',
      canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
      conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
      encryptAttachment: mockEncrypt,
    };
    mockGetActiveXmtpClient.mockReturnValue(client);

    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const file = { fileUri: 'file:///photos/a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' };
    await act(async () => { await result.current.sendAttachment(file); });

    expect(result.current.messages).toEqual([
      expect.objectContaining({ id: 'srv-att-1', kind: 'attachment', delivery: 'failed' }),
    ]);

    const echoContent = {
      url: 'https://files.example/d1', scheme: 'https://' as const,
      contentDigest: 'd1', secret: 's', salt: 'l', nonce: 'n', filename: 'a.jpg',
    };
    await act(async () => {
      await onMessage!({
        id: 'srv-att-1', senderInboxId: 'my-inbox', sentNs: 7,
        contentTypeId: 'xmtp.org/remoteStaticAttachment:1.0',
        content: () => echoContent, fallback: undefined, childMessages: [],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });
});

describe('messages the SDK stored but has not published', () => {
  function mount(history: unknown[], dmExtra: Record<string, unknown>, dmId: string) {
    let onMessage: ((m: unknown) => Promise<void>) | null = null;
    const dm = {
      id: dmId,
      sync: jest.fn().mockResolvedValue(undefined),
      messagesWithReactions: jest.fn().mockResolvedValue(history),
      messages: jest.fn(),
      streamMessages: jest.fn(async (cb: (m: unknown) => Promise<void>) => { onMessage = cb; return () => {}; }),
      ...dmExtra,
    };
    const client = {
      inboxId: 'my-inbox',
      canMessage: jest.fn().mockResolvedValue({ '0xpeer': true }),
      conversations: { findDmByIdentity: jest.fn().mockResolvedValue(dm) },
    };
    mockGetActiveXmtpClient.mockReturnValue(client);
    return { dm, echo: (m: unknown) => onMessage!(m) };
  }

  test('history shows my message the SDK gave up publishing as failed', async () => {
    mount([myText('m8', 'lost', 3, 'FAILED')], {}, 'dm-u1');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.messages[0]).toMatchObject({ id: 'm8', delivery: 'failed' });
  });

  test('retrying an unpublished history message publishes it now, without a second send', async () => {
    const send = jest.fn();
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    const { echo } = mount([myText('m7', 'waiting', 3, 'UNPUBLISHED')], { send, publishPreparedMessages }, 'dm-u2');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(publishPreparedMessages).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    await act(async () => { await echo(myText('m7', 'waiting', 4)); });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });

  test('retrying a failed history message sends its text again, since the SDK will not publish it', async () => {
    const send = jest.fn().mockResolvedValue('m8b');
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    mount([myText('m8', 'lost', 3, 'FAILED')], { send, publishPreparedMessages }, 'dm-u3');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(send).toHaveBeenCalledWith('lost');
    expect(publishPreparedMessages).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'm8b', delivery: 'sent' })]);
  });

  test('a sendWithStatus rejection carrying messageId keys the failed bubble, and retry republishes it', async () => {
    const send = jest.fn();
    const sendWithStatus = jest.fn().mockRejectedValue(Object.assign(new Error('publish failed'), { messageId: 'srv-w' }));
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    mount([], { send, sendWithStatus, publishPreparedMessages }, 'dm-u4');
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { await result.current.send('hi'); });
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-w', delivery: 'failed' })]);

    await act(async () => { await result.current.retryMessage(result.current.messages[0]); });

    expect(publishPreparedMessages).toHaveBeenCalledTimes(1);
    expect(sendWithStatus).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([expect.objectContaining({ id: 'srv-w', delivery: 'sent' })]);
  });

  test('an echo that arrives before the queued ack leaves one bubble, the echo', async () => {
    let echoNow: (m: unknown) => Promise<void> = async () => {};
    const sendWithStatus = jest.fn(async () => {
      await echoNow(myText('m9', 'hi', 5));
      return { id: 'm9', status: 'queued' };
    });
    const { echo } = mount([], { send: jest.fn(), sendWithStatus }, 'dm-u5');
    echoNow = echo;
    const { result } = renderHook(() => useConversation('0xpeer'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => { await result.current.send('hi'); });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({ id: 'm9' });
    expect(result.current.messages[0]).not.toHaveProperty('delivery');
  });
});
