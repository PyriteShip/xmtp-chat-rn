// The shipped uploaders are where a host's storage meets the URL rules other
// XMTP clients depend on: a presigned PUT must actually succeed before its
// public URL is trusted, and an IPFS upload must become an https gateway URL.
// The proxy uploader and the timeout wrapping apply to every uploader, so
// their tests exercise both `createPresignedPutUploader` and
// `createProxyUploader` rather than picking one.
import {
  DEFAULT_UPLOAD_TIMEOUT_MS,
  createIpfsUploader,
  createPresignedPutUploader,
  createProxyUploader,
} from './attachmentUploaders';

const file = { encryptedFileUri: 'file:///tmp/enc', byteLength: 10, contentDigest: 'abc' };
const fileNoLength = { ...file, byteLength: null };
const blob = new Blob(['cipher']);
const readFile = jest.fn().mockResolvedValue(blob);
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = mockFetch;
});

afterEach(() => {
  jest.useRealTimers();
});

test('presigned PUT uploads the ciphertext and returns the public url', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  const presign = jest.fn().mockResolvedValue({
    uploadUrl: 'https://bucket.example/abc?sig=1',
    publicUrl: 'https://cdn.example/abc',
    headers: { 'x-amz-acl': 'public-read' },
  });
  const upload = createPresignedPutUploader(presign, { readFile });
  await expect(upload(file)).resolves.toBe('https://cdn.example/abc');
  expect(presign).toHaveBeenCalledWith(file);
  expect(readFile).toHaveBeenCalledWith('file:///tmp/enc');
  expect(mockFetch).toHaveBeenCalledWith('https://bucket.example/abc?sig=1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'x-amz-acl': 'public-read' },
    body: blob,
    signal: expect.any(AbortSignal),
  });
});

test('presigned PUT throws on a non-2xx response', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 403 });
  const presign = jest.fn().mockResolvedValue({ uploadUrl: 'https://b/x', publicUrl: 'https://c/x' });
  await expect(createPresignedPutUploader(presign, { readFile })(file)).rejects.toThrow('HTTP 403');
});

test('IPFS builds an https gateway url from the pinned CID', async () => {
  const pin = jest.fn().mockResolvedValue('bafyCID');
  const upload = createIpfsUploader({ pin, gateway: 'https://acme.mypinata.cloud/' });
  await expect(upload(file)).resolves.toBe('https://acme.mypinata.cloud/ipfs/bafyCID');
  expect(pin).toHaveBeenCalledWith(file);
});

test('IPFS refuses a non-https gateway at setup', () => {
  expect(() => createIpfsUploader({ pin: jest.fn(), gateway: 'ipfs://' })).toThrow('https://');
});

describe('createProxyUploader', () => {
  test('posts the ciphertext to the endpoint with digest/bytes headers and returns the url', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'https://cdn.example/abc' }) });
    const upload = createProxyUploader({ endpoint: 'https://api.example/attachments', readFile });
    await expect(upload(file)).resolves.toBe('https://cdn.example/abc');
    expect(readFile).toHaveBeenCalledWith('file:///tmp/enc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example/attachments');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({
      'content-type': 'application/octet-stream',
      'x-attachment-digest': 'abc',
      'x-attachment-bytes': '10',
    });
  });

  test('omits x-attachment-bytes when byteLength is null', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'https://cdn.example/abc' }) });
    const upload = createProxyUploader({ endpoint: 'https://api.example/attachments', readFile });
    await upload(fileNoLength);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toEqual({
      'content-type': 'application/octet-stream',
      'x-attachment-digest': 'abc',
    });
  });

  test('supports a custom method and an async headers callback', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'https://cdn.example/abc' }) });
    const headers = jest.fn().mockResolvedValue({ authorization: 'Bearer tok' });
    const upload = createProxyUploader({
      endpoint: 'https://worker.example/upload',
      method: 'PUT',
      headers,
      readFile,
    });
    await upload(file);
    expect(headers).toHaveBeenCalledWith(file);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({
      authorization: 'Bearer tok',
      'content-type': 'application/octet-stream',
      'x-attachment-digest': 'abc',
      'x-attachment-bytes': '10',
    });
  });

  test('a custom publicUrl extracts the url from the response', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => 'https://cdn.example/plain' });
    const upload = createProxyUploader({
      endpoint: 'https://api.example/attachments',
      readFile,
      publicUrl: (res) => res.text(),
    });
    await expect(upload(file)).resolves.toBe('https://cdn.example/plain');
  });

  test('throws on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const upload = createProxyUploader({ endpoint: 'https://api.example/attachments', readFile });
    await expect(upload(file)).rejects.toThrow('HTTP 500');
  });

  // A caller header that differs only in case from a fixed one ('content-type'
  // vs 'Content-Type') is a distinct JS object key, so without normalizing it
  // first, the merge below produces two headers instead of one override — and
  // fetch's Headers combines same-name headers rather than replacing one with
  // the other, silently defeating "caller can't clobber our fixed headers".
  test('a caller header differing only in case from a fixed one does not produce a duplicate', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'https://cdn.example/abc' }) });
    const headers = jest.fn().mockResolvedValue({ 'Content-Type': 'evil/type', 'X-Attachment-Digest': 'evil-digest' });
    const upload = createProxyUploader({ endpoint: 'https://api.example/attachments', headers, readFile });
    await upload(file);
    const [, init] = mockFetch.mock.calls[0];
    expect(Object.keys(init.headers).length).toBe(3); // not 5 — every fixed/caller pair collided to one key
    expect(init.headers['content-type']).toBe('application/octet-stream');
    expect(init.headers['x-attachment-digest']).toBe('abc');
  });
});

describe('upload timeout', () => {
  test('DEFAULT_UPLOAD_TIMEOUT_MS is 60 seconds', () => {
    expect(DEFAULT_UPLOAD_TIMEOUT_MS).toBe(60_000);
  });

  test('a hung presigned PUT upload times out', async () => {
    jest.useFakeTimers();
    const presign = jest.fn().mockResolvedValue({ uploadUrl: 'https://b/x', publicUrl: 'https://c/x' });
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const outcome = createPresignedPutUploader(presign, { readFile, timeoutMs: 5_000 })(file).then(
      () => 'resolved',
      (e) => e.message,
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toBe('Attachment upload timed out after 5000ms');
  });

  test('a hung proxy upload times out using the default timeout', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const outcome = createProxyUploader({ endpoint: 'https://api.example/attachments', readFile })(file).then(
      () => 'resolved',
      (e) => e.message,
    );
    await jest.advanceTimersByTimeAsync(DEFAULT_UPLOAD_TIMEOUT_MS);
    await expect(outcome).resolves.toBe(`Attachment upload timed out after ${DEFAULT_UPLOAD_TIMEOUT_MS}ms`);
  });

  // fetch()'s own promise resolves as soon as HEADERS arrive; reading the
  // body (res.json(), here standing in for the proxy uploader's default
  // publicUrl extraction) happens afterward. A proxy that returns 200 and
  // then stalls the body must still be caught by the same bound — otherwise
  // the timeout added for exactly this purpose doesn't cover the failure it
  // was meant to prevent. Aborting a still-open request also aborts its
  // response body stream, which is what makes json() reject at the deadline
  // below (mirroring real fetch/undici semantics).
  test('a proxy upload whose response body stalls after headers arrive still times out', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      }),
    );
    const outcome = createProxyUploader({ endpoint: 'https://api.example/attachments', readFile })(file).then(
      () => 'resolved',
      (e) => e.message,
    );
    await jest.advanceTimersByTimeAsync(DEFAULT_UPLOAD_TIMEOUT_MS);
    await expect(outcome).resolves.toBe(`Attachment upload timed out after ${DEFAULT_UPLOAD_TIMEOUT_MS}ms`);
  });

  test('timeoutMs: 0 disables the timeout — no signal is attached', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const presign = jest.fn().mockResolvedValue({ uploadUrl: 'https://b/x', publicUrl: 'https://c/x' });
    await createPresignedPutUploader(presign, { readFile, timeoutMs: 0 })(file);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeUndefined();
  });

  test('a negative timeoutMs also disables the timeout', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'https://c/x' }) });
    const upload = createProxyUploader({ endpoint: 'https://api.example/x', readFile, timeoutMs: -1 });
    await upload(file);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeUndefined();
  });
});
