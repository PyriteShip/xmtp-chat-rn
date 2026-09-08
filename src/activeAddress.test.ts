const mem: Record<string, string> = {};
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (k: string) => mem[k],
    set: (k: string, v: string) => { mem[k] = v; },
    remove: (k: string) => { delete mem[k]; },
  }),
}));

import { getActiveXmtpAddress, setActiveXmtpAddress, clearActiveXmtpAddress } from './activeAddress';

describe('activeAddress', () => {
  it('round-trips and lowercases, clears', () => {
    expect(getActiveXmtpAddress()).toBeNull();
    setActiveXmtpAddress('0xABCdef');
    expect(getActiveXmtpAddress()).toBe('0xabcdef');
    clearActiveXmtpAddress();
    expect(getActiveXmtpAddress()).toBeNull();
  });
});
