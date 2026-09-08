import type { DecodedMessage } from '@xmtp/react-native-sdk';
import { isReply, isReaction, decodeReply, decodeReaction } from './replyReaction';

function msg(contentTypeId: string, content: unknown): DecodedMessage {
  return { contentTypeId, content: () => content } as unknown as DecodedMessage;
}
function throwingMsg(contentTypeId: string): DecodedMessage {
  return {
    contentTypeId,
    content: () => {
      throw new Error('decode failed');
    },
  } as unknown as DecodedMessage;
}

const REPLY = 'xmtp.org/reply:1.0';
const REACTION_V1 = 'xmtp.org/reaction:1.0';
const REACTION_V2 = 'xmtp.org/reaction:2.0';

describe('isReply / isReaction', () => {
  it('recognizes the native reply type', () => {
    expect(isReply(msg(REPLY, {}))).toBe(true);
    expect(isReaction(msg(REPLY, {}))).toBe(false);
  });

  it('recognizes both reaction wire versions', () => {
    expect(isReaction(msg(REACTION_V1, {}))).toBe(true);
    expect(isReaction(msg(REACTION_V2, {}))).toBe(true);
  });

  it('does not claim our own card types', () => {
    expect(isReply(msg('example.test/subject:1.0', {}))).toBe(false);
    expect(isReaction(msg('example.test/action:1.0', {}))).toBe(false);
  });
});

describe('decodeReply', () => {
  it('reads a reply whose payload nests the text under `text`', () => {
    const m = msg(REPLY, { reference: 'msg-7', content: { text: 'I don\'t see it' } });
    expect(decodeReply(m)).toEqual({ reference: 'msg-7', text: "I don't see it" });
  });

  it('reads a reply whose payload is a bare string', () => {
    const m = msg(REPLY, { reference: 'msg-7', content: 'on my way' });
    expect(decodeReply(m)).toEqual({ reference: 'msg-7', text: 'on my way' });
  });

  it('returns null for a non-text reply (an attachment from another client)', () => {
    const m = msg(REPLY, { reference: 'msg-7', content: { attachment: { filename: 'a.png' } } });
    expect(decodeReply(m)).toBeNull();
  });

  it('returns null when the reference is missing — a quote with no target', () => {
    expect(decodeReply(msg(REPLY, { content: { text: 'hi' } }))).toBeNull();
    expect(decodeReply(msg(REPLY, { reference: '', content: { text: 'hi' } }))).toBeNull();
  });

  it('returns null for whitespace-only reply text', () => {
    expect(decodeReply(msg(REPLY, { reference: 'm', content: { text: '   ' } }))).toBeNull();
  });

  it('returns null rather than throwing when the decode throws', () => {
    expect(decodeReply(throwingMsg(REPLY))).toBeNull();
  });

  it('returns null for a message that is not a reply', () => {
    expect(decodeReply(msg('xmtp.org/text:1.0', 'hello'))).toBeNull();
  });
});

describe('decodeReaction', () => {
  const added = { reference: 'msg-7', action: 'added', schema: 'unicode', content: '👍' };

  it('reads an added unicode reaction', () => {
    expect(decodeReaction(msg(REACTION_V2, added))).toEqual(added);
  });

  it('reads a v1 reaction from an older client', () => {
    expect(decodeReaction(msg(REACTION_V1, added))).toEqual(added);
  });

  it('reads a removal', () => {
    const removed = { ...added, action: 'removed' };
    expect(decodeReaction(msg(REACTION_V2, removed))).toEqual(removed);
  });

  it('accepts a missing reference — a child reaction is scoped by its parent', () => {
    const child = { ...added, reference: '' };
    expect(decodeReaction(msg(REACTION_V2, child))).toEqual(child);
  });

  it.each(['shortcode', 'custom', 'unknown'])(
    'drops a %s-schema reaction, which would render as literal text',
    (schema) => {
      expect(decodeReaction(msg(REACTION_V2, { ...added, schema, content: ':+1:' }))).toBeNull();
    },
  );

  it('drops an unknown action', () => {
    expect(decodeReaction(msg(REACTION_V2, { ...added, action: 'unknown' }))).toBeNull();
  });

  it('drops an empty emoji', () => {
    expect(decodeReaction(msg(REACTION_V2, { ...added, content: '' }))).toBeNull();
  });

  it('returns null rather than throwing when the decode throws', () => {
    expect(decodeReaction(throwingMsg(REACTION_V2))).toBeNull();
  });

  it('returns null for a message that is not a reaction', () => {
    expect(decodeReaction(msg('xmtp.org/text:1.0', 'hello'))).toBeNull();
  });
});
