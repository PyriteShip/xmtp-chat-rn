/**
 * Block a counterparty — the "Report Junk" gesture for an unsaved sender.
 *
 * Maps to XMTP consent: denying the DM moves it out of the `allowed`/`unknown`
 * window `useConversations` lists (see its CONSENT), so the thread stops
 * surfacing. It is local to this inbox — the other party is not notified. If no
 * DM exists yet (they never sent anything) there is nothing to block, so this is
 * a no-op rather than materializing an empty thread just to deny it.
 */

import { PublicIdentity } from '@xmtp/react-native-sdk';
import { getActiveXmtpClient } from './client';

export async function blockContact(counterpartyAddress: string): Promise<void> {
  const client = getActiveXmtpClient();
  if (!client) throw new Error('Messaging unavailable');
  const identity = new PublicIdentity(counterpartyAddress.toLowerCase(), 'ETHEREUM');
  const dm = await client.conversations.findDmByIdentity(identity);
  if (dm) await dm.updateConsent('denied');
}
