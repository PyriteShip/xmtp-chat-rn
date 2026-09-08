import {
  makeLocalTextMessage,
  setDelivery,
  discardMessage,
  reconcileSent,
  mergeStreamed,
  isOptimistic,
} from './deliveryState';
import type { InboxId } from '@xmtp/react-native-sdk';

// A minimal local fixture union — just enough shape to exercise the pure
// delivery-state functions, which are generic over `DeliveryTrackedMessage`
// and never need a host's concrete chat message type. The `contact` kind
// stands in for an arbitrary custom-codec card kind, to prove
// `mergeStreamed` passes non-text kinds through untouched.
type TestChatMessage =
  | {
      id: string;
      senderInboxId: InboxId;
      sentNs: number;
      fromMe: boolean;
      kind: 'text';
      text: string;
      delivery?: 'pending' | 'sent' | 'failed';
      replyToId?: string;
    }
  | {
      id: string;
      senderInboxId: InboxId;
      sentNs: number;
      fromMe: boolean;
      kind: 'contact';
      contact: { address: string; name: string; signature: string };
    };

const streamedText = (id: string, text: string, fromMe: boolean, sentNs = 2e15): TestChatMessage => ({
  id,
  senderInboxId: (fromMe ? 'me' : 'peer') as InboxId,
  sentNs,
  fromMe,
  kind: 'text',
  text,
});

const streamedContact = (id: string, sentNs = 3e15): TestChatMessage => ({
  id,
  senderInboxId: 'peer' as InboxId,
  sentNs,
  fromMe: false,
  kind: 'contact',
  contact: { address: '0xabc', name: 'A', signature: '0xsig' },
});

describe('makeLocalTextMessage', () => {
  it('creates a from-me pending text with a unique local id and ns timestamp', () => {
    const a = makeLocalTextMessage('hi', 'me' as any, 1000);
    const b = makeLocalTextMessage('hi', 'me' as any, 1000);
    expect(a).toMatchObject({ kind: 'text', text: 'hi', fromMe: true, delivery: 'pending' });
    expect(a.sentNs).toBe(1000 * 1e6);
    expect(a.id).not.toBe(b.id);
    expect(isOptimistic(a)).toBe(true);
  });

  it('tolerates a null inboxId (client not yet cached)', () => {
    const m = makeLocalTextMessage('hi', null);
    expect(m.fromMe).toBe(true);
  });
});

describe('setDelivery / discardMessage', () => {
  it('flips delivery on the targeted message only', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const other = streamedText('m1', 'yo', false);
    const next = setDelivery([local, other], local.id, 'failed');
    expect(next.find((m) => m.id === local.id)).toMatchObject({ delivery: 'failed' });
    expect(next.find((m) => m.id === 'm1')).toEqual(other);
  });

  it('retry path: failed → pending', () => {
    const local = { ...makeLocalTextMessage('hi', 'me' as any), delivery: 'failed' as const };
    const next = setDelivery([local], local.id, 'pending');
    expect(next[0]).toMatchObject({ delivery: 'pending' });
  });

  it('discard drops the message', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    expect(discardMessage([local], local.id)).toEqual([]);
  });
});

describe('reconcileSent (ack from dm.send)', () => {
  it('adopts the network id and flips to sent', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const next = reconcileSent([local], local.id, 'net1');
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'net1', delivery: 'sent', text: 'hi' });
  });

  it('drops the local copy when the stream echo already landed (echo beat ack)', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const echo = streamedText('net1', 'hi', true);
    const next = reconcileSent([echo, local], local.id, 'net1');
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(echo);
  });
});

describe('mergeStreamed', () => {
  it('inserts a new message newest-first', () => {
    const older = streamedText('m1', 'a', false, 1e15);
    const newer = streamedText('m2', 'b', false, 2e15);
    expect(mergeStreamed([older], newer)).toEqual([newer, older]);
    expect(mergeStreamed([newer], older)).toEqual([newer, older]);
  });

  it('skips a duplicate id (regression: stream echo of an already-listed message)', () => {
    const m = streamedText('m1', 'a', true);
    expect(mergeStreamed([m], streamedText('m1', 'a', true))).toEqual([m]);
  });

  it('replaces the optimistic copy when the echo shares its id (ack beat echo)', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const acked = reconcileSent([local], local.id, 'net1');
    const echo = streamedText('net1', 'hi', true);
    const next = mergeStreamed(acked, echo);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(echo); // authoritative copy — no delivery field
    expect(isOptimistic(next[0])).toBe(false);
  });

  it('replaces a same-text in-flight local when the echo arrives before the ack', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const echo = streamedText('net1', 'hi', true);
    const next = mergeStreamed([local], echo);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(echo);
  });

  it('does NOT absorb a failed local into an echo of a different send', () => {
    // Same text sent twice: first failed, second delivered. The failed bubble
    // must survive so the user can still retry or discard it.
    const failed = { ...makeLocalTextMessage('hi', 'me' as any), delivery: 'failed' as const };
    const echo = streamedText('net2', 'hi', true);
    const next = mergeStreamed([failed], echo);
    expect(next).toHaveLength(2);
    expect(next.some((m) => m.kind === 'text' && m.delivery === 'failed')).toBe(true);
  });

  it("does not match a peer's same-text message against a local copy", () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const theirs = streamedText('net1', 'hi', false);
    expect(mergeStreamed([local], theirs)).toHaveLength(2);
  });

  it('passes custom-codec kinds through untouched (no text reconciliation)', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const contact = streamedContact('c1');
    const next = mergeStreamed([local], contact);
    expect(next).toHaveLength(2);
    expect(next.find((m) => m.id === 'c1')).toEqual(contact);
  });
});
