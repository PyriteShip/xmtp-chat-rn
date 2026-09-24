import { sendTracked, republishStored } from './publishState';

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
