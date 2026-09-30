import { resolveSenderAddress } from './senderAddress';

test('returns the sender address lowercased, as documented', async () => {
  const client = {
    inboxStates: jest.fn().mockResolvedValue([
      { inboxId: 'i', identities: [{ kind: 'ETHEREUM', identifier: '0xAbCdEf' }] },
    ]),
  };
  expect(await resolveSenderAddress(client as any, 'i')).toBe('0xabcdef');
});
