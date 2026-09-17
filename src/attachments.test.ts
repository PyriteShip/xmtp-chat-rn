// Attachment I/O is the one path that hands data to a host hook, so the
// contract with those hooks is pinned here: ciphertext out, https in, the size
// limit enforced before anything leaves the device, and one download per file.
import { configureXmtpChat } from './configure';
import {
  AttachmentTooLargeError,
  __resetAttachmentCache,
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
  __resetAttachmentCache();
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

test('rejects an oversized file before upload', async () => {
  configure(1000);
  await expect(uploadAttachment(file)).rejects.toBeInstanceOf(AttachmentTooLargeError);
  expect(upload).not.toHaveBeenCalled();
});

test('rejects an upload that resolves a non-https url', async () => {
  upload.mockResolvedValue('ipfs://bafy');
  await expect(uploadAttachment(file)).rejects.toThrow('https://');
});

test('throws when attachments are not configured', async () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  await expect(uploadAttachment(file)).rejects.toThrow('attachments');
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
