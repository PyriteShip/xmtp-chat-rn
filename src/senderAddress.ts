import type { Client, InboxId } from '@xmtp/react-native-sdk';

/** Resolve a sender/peer inbox id to its primary Ethereum address (lowercased),
 *  or null on any failure. Shared by foreground notifications and the background
 *  decrypted-preview render. */
export async function resolveSenderAddress(client: Client, inboxId: string): Promise<string | null> {
  try {
    const states = await client.inboxStates(false, [inboxId as InboxId]);
    const identities = states[0]?.identities ?? [];
    const eth = identities.find((i) => i.kind === 'ETHEREUM') ?? identities[0];
    return eth?.identifier ?? null;
  } catch {
    return null;
  }
}
