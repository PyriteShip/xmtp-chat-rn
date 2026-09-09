import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { isReadReceipt, sendReadReceipt, shouldSendReadReceipt } from './readReceipt';
import { configureXmtpChat } from './configure';

const READ_RECEIPT = 'xmtp.org/readReceipt:1.0';

function msg(contentTypeId: string): DecodedMessage {
  return { contentTypeId } as unknown as DecodedMessage;
}

describe('isReadReceipt', () => {
  it('recognizes the native read-receipt type', () => {
    expect(isReadReceipt(msg(READ_RECEIPT))).toBe(true);
  });

  it('does not claim the other native types', () => {
    expect(isReadReceipt(msg('xmtp.org/text:1.0'))).toBe(false);
    expect(isReadReceipt(msg('xmtp.org/reaction:2.0'))).toBe(false);
    expect(isReadReceipt(msg('xmtp.org/reply:1.0'))).toBe(false);
  });

  it('does not claim a host card type', () => {
    expect(isReadReceipt(msg('example.test/action:1.0'))).toBe(false);
  });

  it('tolerates a message with no contentTypeId', () => {
    expect(isReadReceipt({} as unknown as DecodedMessage)).toBe(false);
  });
});

describe('sendReadReceipt', () => {
  it('sends an empty payload under the read-receipt content type', async () => {
    const dm = { send: jest.fn().mockResolvedValue('m-1') };
    await sendReadReceipt(dm as any);
    expect(dm.send).toHaveBeenCalledWith(
      {},
      { contentType: { authorityId: 'xmtp.org', typeId: 'readReceipt', versionMajor: 1, versionMinor: 0 } },
    );
  });

  it('swallows a send failure — a receipt must never break reading a thread', async () => {
    const dm = { send: jest.fn().mockRejectedValue(new Error('network down')) };
    await expect(sendReadReceipt(dm as any)).resolves.toBeUndefined();
  });
});

describe('shouldSendReadReceipt', () => {
  const enable = (readReceipts: boolean) =>
    configureXmtpChat({ env: 'dev', enabled: true, cards: [], readReceipts });

  const inbound = (contentTypeId = 'xmtp.org/text:1.0') => msg(contentTypeId);

  it('sends for a counterparty message that advanced the watermark', () => {
    enable(true);
    expect(shouldSendReadReceipt(inbound(), { advanced: true, fromMe: false })).toBe(true);
  });

  it('never sends for a read receipt — two clients would ack each other forever', () => {
    enable(true);
    expect(shouldSendReadReceipt(msg(READ_RECEIPT), { advanced: true, fromMe: false })).toBe(false);
  });

  it('does not send when the watermark did not advance', () => {
    enable(true);
    expect(shouldSendReadReceipt(inbound(), { advanced: false, fromMe: false })).toBe(false);
  });

  it('does not send for my own message — there is nobody to tell', () => {
    enable(true);
    expect(shouldSendReadReceipt(inbound(), { advanced: true, fromMe: true })).toBe(false);
  });

  it('does not send when the host has not opted in', () => {
    enable(false);
    expect(shouldSendReadReceipt(inbound(), { advanced: true, fromMe: false })).toBe(false);
  });

  it('treats an absent readReceipts flag as opted out', () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
    expect(shouldSendReadReceipt(inbound(), { advanced: true, fromMe: false })).toBe(false);
  });
});
