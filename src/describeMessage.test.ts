// `unread` is derived from a preview being non-empty, so the two states that
// must read as "nothing to show" are pinned here: un-reacting is not news, and
// a card with no fallback must not light an unread dot on an empty row.
import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { describeMessage, isPreviewable } from './describeMessage';
import { configureXmtpChat } from './configure';
import type { CardType } from './cardRegistry';

// A minimal registry of four distinct card kinds, none with a `preview` hook —
// exercises the generic wire-fallback passthrough `findCardType`/`describeMessage`
// give any registered card type, without this package depending on a host's
// concrete registry. Only `kind` and `is` matter here: describeMessage never
// touches a card's `codec` or `isValid`.
function fixtureCard(kind: string, contentTypeId: string): CardType<string, unknown, string> {
  return {
    kind,
    payloadKey: 'x',
    codec: {
      contentType: { authorityId: 'test', typeId: kind, versionMajor: 1, versionMinor: 0 },
      encode: () => ({ type: {} as any, parameters: {}, content: new Uint8Array() }),
      decode: () => ({}),
      fallback: () => undefined,
      shouldPush: () => false,
    },
    is: (m) => m.contentTypeId === contentTypeId,
    isValid: (c): c is unknown => true,
  };
}

const TEST_CARD_TYPES: readonly CardType<string, unknown, string>[] = [
  fixtureCard('card', 'example.test/subject:1.0'),
  fixtureCard('completed', 'example.test/completed:1.0'),
  fixtureCard('report', 'example.test/report:1.0'),
  fixtureCard('tagHandoff', 'example.test/handoff:1.0'),
];

beforeEach(() => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: TEST_CARD_TYPES });
});

function msg(contentTypeId: string, content: unknown = {}, fallback?: string): DecodedMessage {
  return { contentTypeId, fallback, content: () => content } as unknown as DecodedMessage;
}

test('plain text describes as its text', () => {
  expect(describeMessage(msg('xmtp.org/text:1.0', 'hello there'))).toEqual({
    kind: 'text',
    text: 'hello there',
  });
});

test('a quoted reply describes as the text that was typed', () => {
  const reply = msg('xmtp.org/reply:1.0', {
    reference: 'msg-7',
    content: { text: "I don't see it" },
  }, 'Replied with "I don\'t see it" to an earlier message');
  expect(describeMessage(reply)).toEqual({ kind: 'text', text: "I don't see it" });
});

test('an added reaction describes as the emoji, direction carried', () => {
  const reaction = msg('xmtp.org/reaction:2.0', {
    reference: 'msg-7', action: 'added', schema: 'unicode', content: '👍',
  }, 'Reacted "👍" to an earlier message');
  expect(describeMessage(reaction, { fromMe: true })).toEqual({
    kind: 'reaction', emoji: '👍', fromMe: true,
  });
});

test('un-reacting describes as nothing — it must not light an unread dot', () => {
  const removal = msg('xmtp.org/reaction:2.0', {
    reference: 'msg-7', action: 'removed', schema: 'unicode', content: '👍',
  }, 'Removed "👍" from an earlier message');
  const d = describeMessage(removal, { fromMe: false });
  expect(d).toEqual({ kind: 'none' });
  expect(isPreviewable(d)).toBe(false);
});

// Every registered card content type resolves to its own `cardKind` and, with
// no preview hook of its own, carries the codec's wire fallback straight
// through — so a thread whose latest message is any of these never reads
// "nothing to show" next to a real timestamp.
test.each([
  ['example.test/subject:1.0', 'card', 'Re: Subject'],
  ['example.test/completed:1.0', 'completed', 'Completed for Subject'],
  ['example.test/report:1.0', 'report', 'Report for Subject'],
  ['example.test/handoff:1.0', 'tagHandoff', 'Handoff for Subject'],
])('%s describes with its kind and wire fallback', (contentTypeId, cardKind, fallback) => {
  const d = describeMessage(msg(contentTypeId, { id: '7' }, fallback));
  expect(d).toEqual({ kind: 'card', cardKind, preview: null, fallback });
  expect(isPreviewable(d)).toBe(true);
});

test('a card with no fallback and no preview is not previewable', () => {
  const d = describeMessage(msg('example.test/subject:1.0', { id: '7' }));
  expect(isPreviewable(d)).toBe(false);
});

// A reply whose replied-with content isn't text (an attachment reply from
// another client) can't unwrap to typed text, so it falls through to the
// `isReply` branch and describes as a card carrying the codec's wire fallback
// — not `none`, since a reply that exists is still something to show.
test('a reply whose payload is not text describes via its wire fallback', () => {
  const reply = msg('xmtp.org/reply:1.0', {
    reference: 'msg-7',
    content: { attachment: { filename: 'a.png' } },
  }, 'Replied to an earlier message');
  const d = describeMessage(reply);
  expect(d).toEqual({
    kind: 'card', cardKind: 'reply', preview: null, fallback: 'Replied to an earlier message',
  });
  expect(isPreviewable(d)).toBe(true);
});

test('system content describes as nothing', () => {
  const d = describeMessage(msg('xmtp.org/group_updated:1.0'));
  expect(d).toEqual({ kind: 'none' });
  expect(isPreviewable(d)).toBe(false);
});

describe('read receipts', () => {
  it('describes a read receipt as nothing, so it can never light an unread dot', () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: TEST_CARD_TYPES });
    const receipt = {
      contentTypeId: 'xmtp.org/readReceipt:1.0',
      content: () => ({}),
      fallback: undefined,
    } as unknown as DecodedMessage;
    const description = describeMessage(receipt);
    expect(description).toEqual({ kind: 'none' });
    expect(isPreviewable(description)).toBe(false);
  });

  it('stays nothing even if a receipt arrives carrying a fallback string', () => {
    configureXmtpChat({ env: 'dev', enabled: true, cards: TEST_CARD_TYPES });
    const receipt = {
      contentTypeId: 'xmtp.org/readReceipt:1.0',
      content: () => ({}),
      fallback: 'Read',
    } as unknown as DecodedMessage;
    expect(describeMessage(receipt)).toEqual({ kind: 'none' });
  });
});
