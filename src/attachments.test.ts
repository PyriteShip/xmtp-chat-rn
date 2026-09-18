// Attachment I/O is the one path that hands data to a host hook, so the
// contract with those hooks is pinned here: ciphertext out, https in, the size
// limit enforced before anything leaves the device, and one download per file.
import { configureXmtpChat } from './configure';
import {
  AttachmentTooLargeError,
  AttachmentsNotConfiguredError,
  clearAttachmentCache,
  openAttachment,
  uploadAttachment,
} from './attachments';

const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();
jest.mock('./client', () => ({
  getActiveXmtpClient: () => ({ encryptAttachment: mockEncrypt, decryptAttachment: mockDecrypt }),
}));

const metadata = { secret: 's', salt: 'l', nonce: 'n', contentDigest: 'digest-1', contentLength: '2048', filename: 'a.jpg' };
const upload = jest.fn();
const download = jest.fn();

function configure(maxBytes?: number) {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [], attachments: { upload, download, maxBytes } });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAttachmentCache();
  mockEncrypt.mockResolvedValue({ encryptedLocalFileUri: 'file:///tmp/enc', metadata });
  mockDecrypt.mockResolvedValue({ fileUri: 'file:///tmp/plain.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' });
  upload.mockResolvedValue('https://files.example/digest-1');
  download.mockResolvedValue('file:///tmp/downloaded');
  configure();
});

const file = { fileUri: 'file:///photos/a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' };

test('uploads the ciphertext and returns sendable content', async () => {
  const content = await uploadAttachment(file);
  expect(mockEncrypt).toHaveBeenCalledWith(file);
  expect(upload).toHaveBeenCalledWith({ encryptedFileUri: 'file:///tmp/enc', byteLength: 2048, contentDigest: 'digest-1' });
  expect(content).toEqual({ ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' });
});

// Native `encryptAttachment` ignores the filename we pass — iOS uses
// `url.lastPathComponent`, Android `uri.lastPathSegment` — so the metadata
// it returns names the picker's temp file, not what the user picked. The
// filename that reaches the wire must be ours.
test('the filename we passed wins over the native metadata filename', async () => {
  mockEncrypt.mockResolvedValue({
    encryptedLocalFileUri: 'file:///tmp/enc',
    metadata: { ...metadata, filename: 'tmp-8f3a.jpg' },
  });
  const content = await uploadAttachment(file);
  expect(content.filename).toBe('a.jpg');
});

test('rejects an oversized file before upload', async () => {
  configure(1000);
  await expect(uploadAttachment(file)).rejects.toBeInstanceOf(AttachmentTooLargeError);
  expect(upload).not.toHaveBeenCalled();
});

// A picker (e.g. expo-image-picker's `fileSize`) can report the plaintext
// size before anything is read into memory. When it does, that is what makes
// `maxBytes` an actual memory guard rather than a backstop that only fires
// after encryptAttachment already paid the memory cost.
test('rejects an oversized file using the caller-supplied byteLength, before encryption', async () => {
  configure(1000);
  await expect(uploadAttachment({ ...file, byteLength: 5000 })).rejects.toBeInstanceOf(AttachmentTooLargeError);
  expect(mockEncrypt).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});

test('a caller-supplied byteLength within the limit still uploads normally', async () => {
  configure(3000); // above both the caller-supplied 2000 and the mocked post-encryption 2048
  const content = await uploadAttachment({ ...file, byteLength: 2000 });
  expect(mockEncrypt).toHaveBeenCalled();
  expect(content.url).toBe('https://files.example/digest-1');
});

test('rejects an upload that resolves a non-https url', async () => {
  upload.mockResolvedValue('ipfs://bafy');
  await expect(uploadAttachment(file)).rejects.toThrow('https://');
});

test('throws when attachments are not configured', async () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await expect(uploadAttachment(file)).rejects.toBeInstanceOf(AttachmentsNotConfiguredError);
});

test('AttachmentsNotConfiguredError carries the expected message', () => {
  const err = new AttachmentsNotConfiguredError();
  expect(err.message).toBe('Attachments are off: pass `attachments` to configureXmtpChat');
  expect(err.name).toBe('AttachmentsNotConfiguredError');
});

test('opening downloads, then decrypts with the message metadata', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  const opened = await openAttachment(content);
  expect(download).toHaveBeenCalledWith('https://files.example/digest-1');
  expect(mockDecrypt).toHaveBeenCalledWith({ encryptedLocalFileUri: 'file:///tmp/downloaded', metadata });
  expect(opened.fileUri).toBe('file:///tmp/plain.jpg');
});

test('concurrent and repeat opens download once', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  await Promise.all([openAttachment(content), openAttachment(content)]);
  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(1);
});

test('a failed open is not cached, so a retry downloads again', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  download.mockRejectedValueOnce(new Error('offline'));
  await expect(openAttachment(content)).rejects.toThrow('offline');
  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(2);
});

test('the sender opens their own upload without downloading it', async () => {
  const content = await uploadAttachment(file);
  const opened = await openAttachment(content);
  expect(download).not.toHaveBeenCalled();
  expect(opened.fileUri).toBe('file:///photos/a.jpg');
});

// The cache must be keyed by more than the digest: two RemoteAttachmentContent
// values can share a contentDigest (same plaintext) while carrying different
// per-file secrets, and reusing the wrong one's decrypted result for the other
// would be silently serving the wrong key's output.
// dropXmtpClient (and resetXmtpLocalState) call this on sign-out so a
// decrypted file from the wallet that just signed out is not still reachable
// after switching identity.
test('clearAttachmentCache forces a fresh download for content already cached', async () => {
  const content = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(1);

  clearAttachmentCache();

  await openAttachment(content);
  expect(download).toHaveBeenCalledTimes(2);
});

// The sender's own upload is primed into the cache without a download (see
// "the sender opens their own upload without downloading it" above); clearing
// must drop that primed entry too, not just downloaded ones.
test('clearAttachmentCache also drops a sender-primed entry', async () => {
  const content = await uploadAttachment(file);
  clearAttachmentCache();
  const opened = await openAttachment(content);
  expect(download).toHaveBeenCalledWith(content.url);
  expect(opened.fileUri).toBe('file:///tmp/plain.jpg'); // the decrypt mock's result, not the local file
});

test('a same-digest content with a different secret does not reuse the cached result', async () => {
  const contentA = { ...metadata, url: 'https://files.example/digest-1', scheme: 'https://' as const };
  await openAttachment(contentA);
  expect(download).toHaveBeenCalledTimes(1);

  const contentB = { ...metadata, secret: 'different-secret', url: 'https://files.example/digest-1-b', scheme: 'https://' as const };
  await openAttachment(contentB);
  expect(download).toHaveBeenCalledTimes(2);
});
