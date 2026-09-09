import { markRead, getLastReadNs, subscribeReadState } from './readState';

const { __resetMMKV } = require('react-native-mmkv');

beforeEach(() => __resetMMKV());

describe('getLastReadNs', () => {
  it('is 0 for a conversation never read', () => {
    expect(getLastReadNs('dm-1')).toBe(0);
  });
});

describe('markRead', () => {
  it('reports true when the watermark advances', () => {
    expect(markRead('dm-1', 1_000)).toBe(true);
    expect(getLastReadNs('dm-1')).toBe(1_000);
  });

  it('reports false when the message is not newer than the watermark', () => {
    markRead('dm-1', 5_000);
    expect(markRead('dm-1', 5_000)).toBe(false);
    expect(markRead('dm-1', 4_000)).toBe(false);
    expect(getLastReadNs('dm-1')).toBe(5_000);
  });

  it('reports false for a missing conversation id or timestamp', () => {
    expect(markRead('', 1_000)).toBe(false);
    expect(markRead('dm-1', 0)).toBe(false);
  });

  it('notifies subscribers only when the watermark advances', () => {
    const cb = jest.fn();
    const unsub = subscribeReadState(cb);
    markRead('dm-1', 2_000);
    markRead('dm-1', 1_000);
    unsub();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
