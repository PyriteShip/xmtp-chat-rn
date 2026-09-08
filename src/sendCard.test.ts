// Every card send must materialize the DM (a first send to a new counterparty
// has no thread yet) and must carry the descriptor's own content type — a send
// with the wrong type decodes as an unknown message on the far side.
import { sendCard } from './sendCard';
import type { CardType } from './cardRegistry';

// A minimal fixture descriptor — sendCard only ever touches `codec.contentType`.
const subject: CardType<'card', { id: string; label: string }, 'card'> = {
  kind: 'card',
  payloadKey: 'card',
  codec: {
    contentType: { authorityId: 'example.test', typeId: 'subject', versionMajor: 1, versionMinor: 0 },
    encode: () => ({ type: {} as any, parameters: {}, content: new Uint8Array() }),
    decode: () => ({ id: '', label: '' }),
    fallback: () => undefined,
    shouldPush: () => false,
  },
  is: () => false,
  isValid: (c): c is { id: string; label: string } => true,
};

const mockSend = jest.fn();
const mockFindOrCreateDmWithIdentity = jest.fn().mockResolvedValue({ send: mockSend });

jest.mock('./client', () => ({
  getActiveXmtpClient: () => ({ conversations: { findOrCreateDmWithIdentity: mockFindOrCreateDmWithIdentity } }),
}));

// `PublicIdentity` is imported lazily inside sendCard.ts (see the file's doc
// comment) precisely because the real SDK pulls in expo-modules-core's
// ESM/native code, which this Babel-only Jest pipeline can't load. The
// repo-wide `@xmtp/react-native-sdk` mock (mapped in jest.config.js) stubs it —
// its `PublicIdentity` just stores `identifier`/`kind`, which is all this file
// exercises.

beforeEach(() => { mockSend.mockClear(); mockFindOrCreateDmWithIdentity.mockClear(); });

test('sends with the card type own content type', async () => {
  await sendCard('0xABC', subject, { id: '7', label: 'Subject' });
  expect(mockSend).toHaveBeenCalledWith(
    { id: '7', label: 'Subject' },
    { contentType: subject.codec.contentType },
  );
});

test('lowercases the counterparty address when resolving the thread', async () => {
  await sendCard('0xABC', subject, { id: '7', label: 'V' });
  expect(mockFindOrCreateDmWithIdentity.mock.calls[0][0].identifier).toBe('0xabc');
});
