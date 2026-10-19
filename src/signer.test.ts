import { PublicIdentity } from '@xmtp/react-native-sdk';
import { createXmtpSigner } from './signer';

describe('createXmtpSigner', () => {
  test('an EOA signer reports no chain and wraps the signature', async () => {
    const signMessage = jest.fn().mockResolvedValue('0xsig');
    const signer = createXmtpSigner({ address: '0xABC', kind: 'EOA', chainId: 8453, signMessage });

    const identity = await signer.getIdentifier();
    expect(identity).toBeInstanceOf(PublicIdentity);
    expect(identity).toMatchObject({ identifier: '0xabc', kind: 'ETHEREUM' });
    expect(signer.signerType?.()).toBe('EOA');
    expect(signer.getChainId?.()).toBeUndefined();
    expect(signer.getBlockNumber?.()).toBeUndefined();
    await expect(signer.signMessage('hello')).resolves.toEqual({ signature: '0xsig' });
    expect(signMessage).toHaveBeenCalledWith('hello');
  });

  test('an SCW signer reports the chain its signature is verified on', () => {
    const signer = createXmtpSigner({ address: '0xabc', kind: 'SCW', chainId: 8453, signMessage: jest.fn() });
    expect(signer.signerType?.()).toBe('SCW');
    expect(signer.getChainId?.()).toBe(8453);
  });

  test('an SCW signer without a chainId is rejected at creation', () => {
    expect(() => createXmtpSigner({ address: '0xabc', kind: 'SCW', signMessage: jest.fn() })).toThrow(TypeError);
  });
});
