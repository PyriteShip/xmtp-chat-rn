// The registry mechanism, tested against synthetic descriptors rather than any
// host's real ones — a host tests that ITS card types are well-formed; this
// tests that lookup and decoding behave for any registry at all.
import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { decodeCard, fallbackNotification, findCardType, type CardType } from './cardRegistry';

function card(kind: string, typeId: string, requiredKey: string): CardType<any, any, any> {
  return {
    kind,
    payloadKey: kind,
    codec: {
      contentType: { authorityId: 'example.test', typeId, versionMajor: 1, versionMinor: 0 },
      encode: () => ({}) as any,
      decode: () => ({}) as any,
      fallback: () => `A ${typeId}`,
      shouldPush: () => false,
    } as any,
    is: (m) => typeof m.contentTypeId === 'string' && m.contentTypeId.startsWith(`example.test/${typeId}`),
    isValid: (c): c is any => !!c && typeof c === 'object' && typeof (c as any)[requiredKey] === 'string',
  };
}

const alpha = card('alpha', 'alpha', 'a');
const beta = card('beta', 'beta', 'b');
const registry = [alpha, beta];

function msg(contentTypeId: string, content: unknown = {}, fallback?: string): DecodedMessage {
  return { contentTypeId, fallback, content: () => content } as unknown as DecodedMessage;
}

describe('findCardType', () => {
  test('returns the descriptor whose `is` claims the message', () => {
    expect(findCardType(registry, msg('example.test/alpha:1.0'))?.kind).toBe('alpha');
    expect(findCardType(registry, msg('example.test/beta:1.0'))?.kind).toBe('beta');
  });

  test('returns null for a type no descriptor claims', () => {
    expect(findCardType(registry, msg('xmtp.org/text:1.0'))).toBeNull();
    expect(findCardType(registry, msg('xmtp.org/group_updated:1.0'))).toBeNull();
  });

  test('an empty registry claims nothing', () => {
    expect(findCardType([], msg('example.test/alpha:1.0'))).toBeNull();
  });

  // Lookup returns the FIRST match, so a registry whose predicates overlap makes
  // order load-bearing. A host is responsible for keeping them exclusive; this
  // pins the resolution rule so the behaviour is at least predictable.
  test('overlapping predicates resolve to the earlier descriptor', () => {
    const greedy: CardType<any, any, any> = { ...card('greedy', 'alpha', 'a'), kind: 'greedy' };
    expect(findCardType([greedy, alpha], msg('example.test/alpha:1.0'))?.kind).toBe('greedy');
    expect(findCardType([alpha, greedy], msg('example.test/alpha:1.0'))?.kind).toBe('alpha');
  });
});

describe('decodeCard', () => {
  test('returns the payload when it satisfies the descriptor guard', () => {
    expect(decodeCard(alpha, msg('example.test/alpha:1.0', { a: 'ok' }))).toEqual({ a: 'ok' });
  });

  // `decode` is unchecked JSON off the wire, so a malformed or future-version
  // payload must degrade to the caller's fallback rather than render half-empty.
  test('returns null when the payload fails the guard', () => {
    expect(decodeCard(alpha, msg('example.test/alpha:1.0', { wrong: 'shape' }))).toBeNull();
    expect(decodeCard(alpha, msg('example.test/alpha:1.0', null))).toBeNull();
  });

  test('returns null when content() throws rather than propagating', () => {
    const throwing = {
      contentTypeId: 'example.test/alpha:1.0',
      content: () => { throw new Error('undecodable'); },
    } as unknown as DecodedMessage;
    expect(decodeCard(alpha, throwing)).toBeNull();
  });
});

describe('fallbackNotification', () => {
  test('carries the wire fallback as the body', () => {
    expect(fallbackNotification(msg('example.test/alpha:1.0', {}, 'A thing happened')))
      .toEqual({ body: 'A thing happened' });
  });

  // A body-less notification is dropped downstream, so returning null here is
  // how a card says "nothing worth showing" rather than emitting an empty one.
  test('returns null when there is no fallback to show', () => {
    expect(fallbackNotification(msg('example.test/alpha:1.0', {}))).toBeNull();
    expect(fallbackNotification(msg('example.test/alpha:1.0', {}, ''))).toBeNull();
  });
});
