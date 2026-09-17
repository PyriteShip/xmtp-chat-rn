// A bubble renders from this hook, so its states are the bubble's states: a
// spinner while the file comes down, the file when it's ready, and a retry that
// works after a failure. Large files must be able to wait for a tap.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useAttachment } from './useAttachment';

const mockOpen = jest.fn();
jest.mock('./attachments', () => ({ openAttachment: (c: unknown) => mockOpen(c) }));

const content = {
  url: 'https://files.example/d', scheme: 'https://' as const,
  contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n',
};
const file = { fileUri: 'file:///plain.jpg', mimeType: 'image/jpeg' };

beforeEach(() => jest.clearAllMocks());

test('loads on mount and reports the file', async () => {
  mockOpen.mockResolvedValue(file);
  const { result } = renderHook(() => useAttachment(content));
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file }));
});

test('autoLoad false waits for load()', async () => {
  mockOpen.mockResolvedValue(file);
  const { result } = renderHook(() => useAttachment(content, { autoLoad: false }));
  expect(result.current.status).toEqual({ state: 'idle' });
  expect(mockOpen).not.toHaveBeenCalled();
  await act(async () => { await result.current.load(); });
  expect(result.current.status).toEqual({ state: 'ready', file });
});

test('a failure is reported and load() retries it', async () => {
  mockOpen.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(file);
  const { result } = renderHook(() => useAttachment(content));
  await waitFor(() => expect(result.current.status).toEqual({ state: 'failed', error: 'offline' }));
  await act(async () => { await result.current.load(); });
  expect(result.current.status).toEqual({ state: 'ready', file });
});

test('no content stays idle', () => {
  const { result } = renderHook(() => useAttachment(undefined));
  expect(result.current.status).toEqual({ state: 'idle' });
  expect(mockOpen).not.toHaveBeenCalled();
});

// A settings toggle can flip `autoLoad` on a bubble whose file already
// loaded (or is mid-flight, or failed). That flip is not a new file, so it
// must never wipe the bubble's displayed state back to idle.
test('a ready bubble stays ready when autoLoad toggles true to false', async () => {
  mockOpen.mockResolvedValue(file);
  const { result, rerender } = renderHook(
    ({ autoLoad }: { autoLoad: boolean }) => useAttachment(content, { autoLoad }),
    { initialProps: { autoLoad: true } },
  );
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file }));

  rerender({ autoLoad: false });
  expect(result.current.status).toEqual({ state: 'ready', file });
});

test('an idle bubble with autoLoad false starts loading once autoLoad turns true', async () => {
  mockOpen.mockResolvedValue(file);
  const { result, rerender } = renderHook(
    ({ autoLoad }: { autoLoad: boolean }) => useAttachment(content, { autoLoad }),
    { initialProps: { autoLoad: false } },
  );
  expect(result.current.status).toEqual({ state: 'idle' });
  expect(mockOpen).not.toHaveBeenCalled();

  rerender({ autoLoad: true });
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file }));
});

test('switching to a different digest resets and loads the new content', async () => {
  const content2 = { ...content, url: 'https://files.example/d2', contentDigest: 'd2' };
  const file2 = { fileUri: 'file:///plain2.jpg', mimeType: 'image/jpeg' };
  mockOpen.mockImplementation((c: { contentDigest: string }) =>
    Promise.resolve(c.contentDigest === 'd2' ? file2 : file),
  );
  const { result, rerender } = renderHook(
    ({ c }: { c: typeof content }) => useAttachment(c),
    { initialProps: { c: content } },
  );
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file }));

  rerender({ c: content2 });
  await waitFor(() => expect(result.current.status).toEqual({ state: 'ready', file: file2 }));
});
