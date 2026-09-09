/**
 * The example's wallet: a throwaway private key, generated on first launch and
 * kept in MMKV so the same inbox survives a reload.
 *
 * This is the piece a real app replaces. `xmtp-chat-rn` holds no wallet
 * dependency at all — it takes an XMTP `Signer` and the address that signer
 * speaks for, and everything else (WalletConnect, a smart wallet, an embedded
 * key) is the host's business. A local key is the smallest thing that
 * satisfies that contract, which is why the demo uses one.
 *
 * It is emphatically NOT how to hold a real key: MMKV here is unencrypted, and
 * the key never touches the OS keystore. It buys a stable identity across
 * reloads for a demo and nothing more.
 */

import { createMMKV } from 'react-native-mmkv';
import { PublicIdentity, type Signer as XmtpSigner } from '@xmtp/react-native-sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const KEY = 'demoPrivateKey';
const store = createMMKV({ id: 'xmtp-chat-rn-example' });

export interface DemoIdentity {
  address: string;
  signer: XmtpSigner;
}

function toIdentity(privateKey: Hex): DemoIdentity {
  const account = privateKeyToAccount(privateKey);
  const address = account.address.toLowerCase();
  return {
    address,
    signer: {
      getIdentifier: async () => new PublicIdentity(address, 'ETHEREUM'),
      // Both only matter for a smart-contract wallet, whose signature XMTP
      // verifies on-chain via ERC-1271. A plain EOA signature is recovered
      // against the address, so there is no chain to name.
      getChainId: () => undefined,
      getBlockNumber: () => undefined,
      signerType: () => 'EOA',
      signMessage: async (message: string) => ({
        signature: await account.signMessage({ message }),
      }),
    },
  };
}

/** The stored demo identity, generating and persisting one on first launch. */
export function loadOrCreateIdentity(): DemoIdentity {
  const stored = store.getString(KEY) as Hex | undefined;
  if (stored) return toIdentity(stored);
  const fresh = generatePrivateKey();
  store.set(KEY, fresh);
  return toIdentity(fresh);
}

/**
 * Throw the current identity away and mint a new one — the demo's "become
 * somebody else" button, and the only practical way to hold both ends of a
 * conversation when you have one device. The old inbox is not deleted, just
 * abandoned; its messages are gone from this app because the key that could
 * read them is.
 */
export function rotateIdentity(): DemoIdentity {
  store.remove(KEY);
  return loadOrCreateIdentity();
}
