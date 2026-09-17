// The shipped uploaders are where a host's storage meets the URL rules other
// XMTP clients depend on: a presigned PUT must actually succeed before its
// public URL is trusted, and an IPFS upload must become an https gateway URL.
import { createIpfsUploader, createPresignedPutUploader } from './attachmentUploaders';

const file = { encryptedFileUri: 'file:///tmp/enc', byteLength: 10, contentDigest: 'abc' };
const blob = new Blob(['cipher']);
const readFile = jest.fn().mockResolvedValue(blob);
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).fetch = mockFetch;
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
