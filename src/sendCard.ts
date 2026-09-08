/**
 * Post a card to a counterparty, creating the thread if there isn't one.
 *
 * Standalone rather than a hook, so a screen outside the chat view can send —
 * e.g. the host posting a card from some other flow entirely (an offer sent
 * from a listing screen, say). An open chat view's live stream echoes the
 * card in; otherwise it lands in the recipient's inbox.
 *
 * `@xmtp/react-native-sdk` is imported lazily inside the function
 * (`await import(...)`), not at module scope, so this module stays importable
 * under Jest without pulling in the SDK's native/ESM module graph.
 */

import { getActiveXmtpClient } from './client';
import type { CardType } from './cardRegistry';

export async function sendCard<T>(
  counterpartyAddress: string,
  cardType: CardType<any, T, string>,
  payload: T,
): Promise<void> {
  const client = getActiveXmtpClient();
  if (!client) throw new Error('Messaging unavailable');
  const { PublicIdentity } = await import('@xmtp/react-native-sdk');
  const identity = new PublicIdentity(counterpartyAddress.toLowerCase(), 'ETHEREUM');
  const dm = await client.conversations.findOrCreateDmWithIdentity(identity);
  await dm.send(payload as any, { contentType: cardType.codec.contentType });
}
