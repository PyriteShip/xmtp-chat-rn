// A remote attachment is the one message whose content points outside XMTP, so
// its decoder is also the guard: a URL we can't fetch as https, or content
// missing the key material, must not become a bubble that fails on tap.
import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { decodeRemoteAttachment, isRemoteAttachment, isStaticAttachment } from './attachmentContent';

const valid = {
  url: 'https://files.example/abc',
  scheme: 'https://',
  contentDigest: 'd1',
  secret: 's',
  salt: 'l',
  nonce: 'n',
  filename: 'photo.jpg',
  contentLength: '1024',
};

function msg(contentTypeId: string, content: unknown): DecodedMessage {
  return { contentTypeId, content: () => content } as unknown as DecodedMessage;
}

test('matches the standard remote attachment content type', () => {
  expect(isRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', valid))).toBe(true);
  expect(isRemoteAttachment(msg('xmtp.org/text:1.0', 'hi'))).toBe(false);
  expect(isRemoteAttachment(undefined)).toBe(false);
});

test('decodes valid content unchanged', () => {
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', valid))).toEqual(valid);
});

test('rejects a non-https url', () => {
  const content = { ...valid, url: 'ipfs://bafy' };
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', content))).toBeNull();
});

test('rejects content missing key material', () => {
  const { secret, ...noSecret } = valid;
  expect(decodeRemoteAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', noSecret))).toBeNull();
});

test('a content() that throws decodes to null', () => {
  const m = {
    contentTypeId: 'xmtp.org/remoteStaticAttachment:1.0',
    content: () => { throw new Error('no codec'); },
  } as unknown as DecodedMessage;
  expect(decodeRemoteAttachment(m)).toBeNull();
});

test('matches the inline static attachment content type', () => {
  expect(isStaticAttachment(msg('xmtp.org/attachment:1.0', {}))).toBe(true);
  expect(isStaticAttachment(msg('xmtp.org/remoteStaticAttachment:1.0', valid))).toBe(false);
  expect(isStaticAttachment(msg('xmtp.org/text:1.0', 'hi'))).toBe(false);
  expect(isStaticAttachment(undefined)).toBe(false);
});
