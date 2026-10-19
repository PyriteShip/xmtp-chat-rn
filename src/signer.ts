import { PublicIdentity, type Signer } from '@xmtp/react-native-sdk';

/** What `createXmtpSigner` needs to sign for a wallet. */
export interface XmtpSignerInput {
  /** The wallet's Ethereum address; XMTP identifies the inbox by it. */
  address: string;
  /**
   * `'EOA'`: XMTP recovers the signature against `address`. `'SCW'`: a
   * smart-contract wallet, which XMTP verifies on chain through ERC-1271
   * `isValidSignature` on `chainId`.
   */
  kind: 'EOA' | 'SCW';
  /** The chain XMTP verifies an SCW signature on. Required for `'SCW'`; ignored for `'EOA'`. */
  chainId?: number;
  /** Signs XMTP's auth message and resolves to the hex signature. */
  signMessage: (message: string) => Promise<string>;
}

/**
 * Adapts a wallet to the SDK's `Signer`, which `getOrCreateXmtpClient` and
 * `revokeAllInstallations` take as part of an `XmtpIdentity`. Which chain an
 * SCW signature is bound to, and how it is produced, stay with the caller.
 */
export function createXmtpSigner(input: XmtpSignerInput): Signer {
  const isSmartWallet = input.kind === 'SCW';
  if (isSmartWallet && input.chainId === undefined) {
    throw new TypeError('createXmtpSigner: an SCW signer needs a chainId');
  }
  const identifier = input.address.toLowerCase();
  return {
    getIdentifier: async () => new PublicIdentity(identifier, 'ETHEREUM'),
    getChainId: () => (isSmartWallet ? input.chainId : undefined),
    getBlockNumber: () => undefined,
    signerType: () => input.kind,
    signMessage: async (message: string) => ({ signature: await input.signMessage(message) }),
  };
}
