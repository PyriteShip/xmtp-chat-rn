import {
  makeLocalTextMessage,
  makeLocalAttachmentMessage,
  attachUploaded,
  setDelivery,
  discardMessage,
  reconcileSent,
  mergeStreamed,
  isOptimistic,
  markReadUpTo,
  isLocalId,
  nextLocalId,
  settleRetry,
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
      delivery?: 'pending' | 'sent' | 'unpublished' | 'failed' | 'read';
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

  it('absorbs a failed local into a same-text echo sent soon after it (the SDK may have stored it before failing)', () => {
    // A `failed` local reconciles the way `pending`/`sent` do: the SDK may have
    // stored the attempt before the publish failed, and its own later echo
    // must not double the bubble. A failed send whose error carried the SDK's
    // id matches by id instead (see the rekeying block below).
    const failed = { ...makeLocalTextMessage('hi', 'me' as any, 1000), delivery: 'failed' as const };
    const echo = streamedText('net2', 'hi', true, failed.sentNs + 5e9);
    const next = mergeStreamed([failed], echo);
    expect(next).toEqual([echo]);
  });

  it('keeps a failed local when a same-text echo was sent long after it', () => {
    // The same words sent again much later (from another device, say) are a
    // different message; absorbing the failed copy would make an undelivered
    // message look delivered.
    const failed = { ...makeLocalTextMessage('hi', 'me' as any, 1000), delivery: 'failed' as const };
    const echo = streamedText('net3', 'hi', true, failed.sentNs + 3600e9);
    const next = mergeStreamed([failed], echo);
    expect(next).toHaveLength(2);
    expect(next).toContainEqual(failed);
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

describe('markReadUpTo', () => {
  // The fixture union's card branch carries no `delivery`, mirroring the host's
  // real ChatMessage, so reading it needs a narrow rather than a cast.
  const deliveryOf = (m: TestChatMessage) => (m.kind === 'text' ? m.delivery : undefined);

  const mine = (id: string, sentNs: number, delivery?: 'pending' | 'sent' | 'failed'): TestChatMessage => ({
    id,
    senderInboxId: 'me' as InboxId,
    sentNs,
    fromMe: true,
    kind: 'text',
    text: id,
    ...(delivery ? { delivery } : {}),
  });

  it('promotes my confirmed messages at or before the receipt to read', () => {
    const out = markReadUpTo([mine('b', 2000), mine('a', 1000)], 2000);
    expect(out.map(deliveryOf)).toEqual(['read', 'read']);
  });

  it('promotes an acked-but-not-echoed message too', () => {
    const out = markReadUpTo([mine('a', 1000, 'sent')], 1000);
    expect(deliveryOf(out[0])).toBe('read');
  });

  it('leaves my messages sent after the receipt alone', () => {
    const out = markReadUpTo([mine('b', 3000), mine('a', 1000)], 2000);
    expect(out.map(deliveryOf)).toEqual([undefined, 'read']);
  });

  it('never marks the counterparty\'s messages — read state is about my own', () => {
    const out = markReadUpTo([streamedText('p', 'hi', false, 1000)], 2000);
    expect(deliveryOf(out[0])).toBeUndefined();
  });

  it('leaves an in-flight or failed message alone — it cannot have been read', () => {
    const out = markReadUpTo([mine('a', 1000, 'pending'), mine('b', 900, 'failed')], 2000);
    expect(out.map(deliveryOf)).toEqual(['pending', 'failed']);
  });

  it('leaves a card message alone — only text bubbles carry delivery state', () => {
    const prev: TestChatMessage[] = [{ ...streamedContact('c', 1000), fromMe: true }];
    expect(markReadUpTo(prev, 2000)).toBe(prev);
  });

  it('returns the same array when nothing changes, so the hook can skip a render', () => {
    const prev = [mine('a', 3000)];
    expect(markReadUpTo(prev, 1000)).toBe(prev);
  });
});

describe('unpublished (stored by the SDK, published later)', () => {
  it('reconcileSent can record an unpublished ack under the stored id', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const next = reconcileSent([local], local.id, 'net9', 'unpublished');
    expect(next[0]).toMatchObject({ id: 'net9', delivery: 'unpublished' });
  });

  it('the echo with the same id replaces it (it is still optimistic)', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const queued = reconcileSent([local], local.id, 'net9', 'unpublished');
    const echo = streamedText('net9', 'hi', true);
    expect(isOptimistic(queued[0])).toBe(true);
    expect(mergeStreamed(queued, echo)).toEqual([echo]);
  });

  it('an echo replaces a failed copy with the same text (the SDK may have stored it before failing)', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const failed = setDelivery([local], local.id, 'failed');
    const echo = streamedText('net10', 'hi', true, local.sentNs + 1e9);
    expect(mergeStreamed(failed, echo)).toEqual([echo]);
  });

  it('a read receipt never promotes an unpublished message', () => {
    const local = makeLocalTextMessage('hi', 'me' as any, 1);
    const queued = reconcileSent([local], local.id, 'net9', 'unpublished');
    expect(markReadUpTo(queued, 9e18)).toBe(queued);
  });
});

describe('setDelivery rekeying a failed send to the id its error carried', () => {
  it('drops the local copy when a message with that id is already listed', () => {
    // The echo for that id already landed (matched by text to another bubble,
    // or inserted on its own): rekeying would list the same id twice.
    const local = makeLocalTextMessage('hi', 'me' as any);
    const echo = streamedText('srv-1', 'hi', true);
    const next = setDelivery([local, echo], local.id, 'failed', 'srv-1');
    expect(next).toEqual([echo]);
  });

  it('rekeys the failed copy to the given id, so mergeStreamed matches the echo by id rather than by text', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const failed = setDelivery([local], local.id, 'failed', 'srv-1');
    expect(failed[0]).toMatchObject({ id: 'srv-1', delivery: 'failed' });
    const echo = streamedText('srv-1', 'hi', true);
    expect(mergeStreamed(failed, echo)).toEqual([echo]);
  });

  it('two failed sends with identical text, each keyed by its own id, each echo reconciles to the correct bubble', () => {
    const a = makeLocalTextMessage('hi', 'me' as any);
    const b = makeLocalTextMessage('hi', 'me' as any);
    let msgs = setDelivery([b, a], a.id, 'failed', 'srv-a');
    msgs = setDelivery(msgs, b.id, 'failed', 'srv-b');
    const echoA = streamedText('srv-a', 'hi', true, 1e15);
    const echoB = streamedText('srv-b', 'hi', true, 2e15);
    let next = mergeStreamed(msgs, echoA);
    next = mergeStreamed(next, echoB);
    expect(next).toHaveLength(2);
    expect(next).toContainEqual(echoA);
    expect(next).toContainEqual(echoB);
  });

  it('without an id, setDelivery leaves the local id unchanged — the text heuristic still applies', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const failed = setDelivery([local], local.id, 'failed');
    expect(failed[0].id).toBe(local.id);
  });
});

describe('isLocalId: telling a local id from one the SDK stored', () => {
  it('is true for an id nextLocalId generated', () => {
    expect(isLocalId(nextLocalId())).toBe(true);
  });

  it('is false for a network/stored id, including one setDelivery rekeyed a local message to', () => {
    expect(isLocalId('net9')).toBe(false);
    const local = makeLocalTextMessage('hi', 'me' as any);
    const failed = setDelivery([local], local.id, 'failed', 'srv-1');
    expect(isLocalId(failed[0].id)).toBe(false);
  });
});

describe('settleRetry', () => {
  it('records the outcome on a bubble still pending', () => {
    const local = makeLocalTextMessage('hi', 'me' as any);
    const pending = setDelivery([local], local.id, 'pending', 'srv-1');
    expect(settleRetry(pending, 'srv-1', 'sent')[0]).toMatchObject({ id: 'srv-1', delivery: 'sent' });
  });

  it('leaves an echo that already replaced the bubble untouched', () => {
    const echo = streamedText('srv-1', 'hi', true);
    const prev = [echo];
    expect(settleRetry(prev, 'srv-1', 'unpublished')).toBe(prev);
  });
});

describe('isOptimistic', () => {
  it('does not treat a read message as optimistic — it is a confirmed network message', () => {
    const read = { ...streamedText('a', 'hi', true, 1000), delivery: 'read' as const };
    expect(isOptimistic(read)).toBe(false);
  });
});

describe('attachments', () => {
  const file = { fileUri: 'file:///a.jpg', mimeType: 'image/jpeg', filename: 'a.jpg' };
  const content = {
    url: 'https://files.example/d', scheme: 'https://' as const,
    contentDigest: 'd', secret: 's', salt: 'l', nonce: 'n', filename: 'a.jpg',
  };

  test('a local attachment starts pending and optimistic', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    expect(local).toMatchObject({ kind: 'attachment', localFile: file, delivery: 'pending', fromMe: true, sentNs: 1000 * 1e6 });
    expect(isOptimistic(local)).toBe(true);
  });

  test('upload content lands on the local copy only', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    const next = attachUploaded([local], local.id, content);
    expect(next[0]).toMatchObject({ attachment: content, delivery: 'pending' });
  });

  test('fails, acks and reads like a text message', () => {
    const local = makeLocalAttachmentMessage(file, 'me' as any, 1000);
    expect(setDelivery([local], local.id, 'failed')[0].delivery).toBe('failed');
    const acked = reconcileSent([local], local.id, 'net-1');
    expect(acked[0]).toMatchObject({ id: 'net-1', delivery: 'sent' });
    expect(markReadUpTo(acked, 2000 * 1e6)[0].delivery).toBe('read');
  });

  test('a stream echo that beats the ack replaces the local copy by digest', () => {
    const localCopy = { ...makeLocalAttachmentMessage(file, 'me' as any, 1000), attachment: content };
    const echo = { id: 'net-1', senderInboxId: 'me', sentNs: 1001 * 1e6, fromMe: true, kind: 'attachment', attachment: content };
    const merged = mergeStreamed([localCopy] as any[], echo as any);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(echo);
  });
});
