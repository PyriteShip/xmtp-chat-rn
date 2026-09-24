// The dedupe ring is what stops one message producing two notifications when
// the stream redelivers. It is bounded so a long-lived install cannot grow it
// without limit, and eviction is oldest-first so a redelivery of something
// recent is still caught.
import { createMMKV } from 'react-native-mmkv';
import { markInboundHandled, wasInboundHandled, forgetInboundHandledCache, __resetInboundHandled } from './inboundMessages';

beforeEach(() => __resetInboundHandled());

test('an unseen id is not handled', () => {
  expect(wasInboundHandled('m1')).toBe(false);
});

test('a marked id is handled, and marking twice is idempotent', () => {
  markInboundHandled('m1');
  markInboundHandled('m1');
  expect(wasInboundHandled('m1')).toBe(true);
});

test('the ring evicts oldest-first past its bound', () => {
  for (let i = 0; i < 205; i += 1) markInboundHandled(`m${i}`);
  expect(wasInboundHandled('m0')).toBe(false);
  expect(wasInboundHandled('m204')).toBe(true);
});

// A host that wipes the 'xmtp' store on sign-out must not still see the old
// identity's ids. They used to survive in the in-memory copy, and the next
// markInboundHandled wrote them back.
test('after the store is wiped and the cache forgotten, old ids are gone', () => {
  markInboundHandled('old-1');
  createMMKV({ id: 'xmtp' }).remove('inbound.handledIds');
  forgetInboundHandledCache();
  expect(wasInboundHandled('old-1')).toBe(false);
  markInboundHandled('new-1');
  expect(JSON.parse(createMMKV({ id: 'xmtp' }).getString('inbound.handledIds')!)).toEqual(['new-1']);
});
