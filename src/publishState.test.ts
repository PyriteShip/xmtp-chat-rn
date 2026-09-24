import { configureXmtpChat } from './configure';
import { sendTracked, republishStored, DEFAULT_PUBLISH_TIMEOUT_MS } from './publishState';

beforeEach(() => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
});

test('uses sendWithStatus when the SDK has it: queued is unpublished, not a failure', async () => {
  const dm = {
    send: jest.fn(),
    sendWithStatus: jest.fn().mockResolvedValue({ id: 'm1', status: 'queued' }),
  };
  await expect(sendTracked(dm, 'hi')).resolves.toEqual({ id: 'm1', delivery: 'unpublished' });
  expect(dm.sendWithStatus).toHaveBeenCalledWith('hi');
  expect(dm.send).not.toHaveBeenCalled();
});

test('published is sent', async () => {
  const dm = { send: jest.fn(), sendWithStatus: jest.fn().mockResolvedValue({ id: 'm2', status: 'published' }) };
  await expect(sendTracked(dm, 'hi', { contentType: 'x' })).resolves.toEqual({ id: 'm2', delivery: 'sent' });
  expect(dm.sendWithStatus).toHaveBeenCalledWith('hi', { contentType: 'x' });
});

test('falls back to send on an SDK without sendWithStatus, with the exact same arguments', async () => {
  const dm = { send: jest.fn().mockResolvedValue('m3') };
  await expect(sendTracked(dm, 'hi')).resolves.toEqual({ id: 'm3', delivery: 'sent' });
  expect(dm.send).toHaveBeenCalledWith('hi');
  expect(dm.send.mock.calls[0]).toHaveLength(1);
});

test('a real failure still rejects', async () => {
  const dm = { send: jest.fn(), sendWithStatus: jest.fn().mockRejectedValue(new Error('group inactive')) };
  await expect(sendTracked(dm, 'hi')).rejects.toThrow('group inactive');
});

describe('sendTracked: prepare then publish, bounded by a timeout, when the SDK offers both', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a publish that resolves is sent, keyed by the prepared id; send is never called', async () => {
    const prepareMessage = jest.fn().mockResolvedValue('prep-1');
    const publishPreparedMessages = jest.fn().mockResolvedValue(undefined);
    const dm = { send: jest.fn(), sendWithStatus: jest.fn(), prepareMessage, publishPreparedMessages };
    await expect(sendTracked(dm, 'hi', { contentType: 'x' })).resolves.toEqual({ id: 'prep-1', delivery: 'sent' });
    expect(prepareMessage).toHaveBeenCalledWith('hi', { contentType: 'x' });
    expect(publishPreparedMessages).toHaveBeenCalledWith();
    expect(dm.send).not.toHaveBeenCalled();
    expect(dm.sendWithStatus).not.toHaveBeenCalled();
  });

  test('a publish that rejects with the unconfirmed-publish error is unpublished, keyed by the prepared id', async () => {
    const prepareMessage = jest.fn().mockResolvedValue('prep-2');
    const publishPreparedMessages = jest.fn().mockRejectedValue(new Error('SyncFailedToWait: timed out'));
    const dm = { send: jest.fn(), prepareMessage, publishPreparedMessages };
    await expect(sendTracked(dm, 'hi')).resolves.toEqual({ id: 'prep-2', delivery: 'unpublished' });
  });

  test('a publish that rejects with any other error fails, keyed by the prepared id so a retry can republish it', async () => {
    const prepareMessage = jest.fn().mockResolvedValue('prep-3');
    const publishPreparedMessages = jest.fn().mockRejectedValue(new Error('group inactive'));
    const dm = { send: jest.fn(), prepareMessage, publishPreparedMessages };
    await expect(sendTracked(dm, 'hi')).rejects.toMatchObject({ message: 'group inactive', messageId: 'prep-3' });
  });

  test('a publish that never settles becomes unpublished after the default timeout, and the background publish is not cancelled', async () => {
    jest.useFakeTimers();
    const prepareMessage = jest.fn().mockResolvedValue('prep-4');
    let settleBackgroundPublish: (() => void) | undefined;
    const publishPreparedMessages = jest.fn(
      () => new Promise<void>((resolve) => { settleBackgroundPublish = resolve; }),
    );
    const dm = { send: jest.fn(), prepareMessage, publishPreparedMessages };

    const result = await (async () => {
      const promise = sendTracked(dm, 'hi');
      await jest.advanceTimersByTimeAsync(DEFAULT_PUBLISH_TIMEOUT_MS);
      return promise;
    })();
    expect(result).toEqual({ id: 'prep-4', delivery: 'unpublished' });
    expect(publishPreparedMessages).toHaveBeenCalledTimes(1); // still in flight, not cancelled or retried

    // The publish finally lands, well after the timeout: nothing throws, and
    // the stream echo (mergeStreamed, tested elsewhere) is what reconciles
    // the bubble from here.
    settleBackgroundPublish!();
    await jest.advanceTimersByTimeAsync(0);
  });

  test('the timeout is configurable via XmtpChatConfig.publishTimeoutMs', async () => {
    jest.useFakeTimers();
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], publishTimeoutMs: 5_000 });
    const prepareMessage = jest.fn().mockResolvedValue('prep-5');
    const publishPreparedMessages = jest.fn(() => new Promise<void>(() => {}));
    const dm = { send: jest.fn(), prepareMessage, publishPreparedMessages };

    const promise = sendTracked(dm, 'hi');
    await jest.advanceTimersByTimeAsync(4_999);
    let settledEarly = false;
    promise.then(() => { settledEarly = true; });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ id: 'prep-5', delivery: 'unpublished' });
  });

  test('on an SDK without prepareMessage/publishPreparedMessages, the old sendWithStatus/send path is unchanged', async () => {
    const send = jest.fn().mockResolvedValue('m-old');
    const dm = { send };
    await expect(sendTracked(dm, 'hi')).resolves.toEqual({ id: 'm-old', delivery: 'sent' });
    expect(send).toHaveBeenCalledWith('hi');
  });
});

describe('republishStored: retry a message the SDK stored without preparing it again', () => {
  test('resolves sent when publishPreparedMessages succeeds', async () => {
    const dm = { publishPreparedMessages: jest.fn().mockResolvedValue(undefined) };
    await expect(republishStored(dm)).resolves.toBe('sent');
    expect(dm.publishPreparedMessages).toHaveBeenCalledWith();
  });

  test('resolves unpublished on an unconfirmed-publish error, never rejects', async () => {
    const dm = { publishPreparedMessages: jest.fn().mockRejectedValue(new Error('SyncFailedToWait: timed out')) };
    await expect(republishStored(dm)).resolves.toBe('unpublished');
  });

  test('resolves failed on any other error, never rejects', async () => {
    const dm = { publishPreparedMessages: jest.fn().mockRejectedValue(new Error('group inactive')) };
    await expect(republishStored(dm)).resolves.toBe('failed');
  });
});
