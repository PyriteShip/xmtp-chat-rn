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
