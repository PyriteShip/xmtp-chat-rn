/**
 * Inbox hook — lists every 1:1 conversation for the active XMTP client, newest
 * activity first, with the counterparty address, a last-message preview, and an
 * unread flag. With `includeGroups`, the groups this inbox belongs to are
 * merged into the same list (read them with `useGroup`); without it the list
 * is DMs only, so a host that renders every row as a DM never meets a group.
 *
 * Refresh model: one-shot load exposed via `refresh()`, called by the host's
 * inbox screen on focus and pull-to-refresh. This hook deliberately does NOT open
 * its own `streamAllMessages` — cancellation is global on `client.conversations`
 * and the stream is already owned by `inboundMessages`; a second stream would
 * fight it. Focus-refresh covers the real UX (read a chat → return → list
 * reorders, unread clears), and incoming messages still surface via the
 * notification the host wires to `startInboundMessages`'s handler.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Client, ConsentState, InboxId } from '@xmtp/react-native-sdk';
import { getActiveXmtpClient, isXmtpClientInitializing, subscribeXmtpClient } from './client';
import { getLastReadNs } from './readState';
import { describeMessage, isPreviewable, type MessageDescription } from './describeMessage';
import { subscribeConversationTopics } from './xmtpPush';

export interface ConversationSummary {
  kind: 'dm';
  /** XMTP conversation id (stable key + read-state key). */
  id: string;
  /** Counterparty's primary Ethereum address (lowercased). */
  peerAddress: string;
  /** What the newest message is; the host renders it into copy. */
  last: MessageDescription;
  /** sentNs of the most recent message (0 if none) — also the sort key. */
  lastSentNs: number;
  /** True when the newest message is from the counterparty and unread. */
  unread: boolean;
}

export interface GroupConversationSummary {
  kind: 'group';
  /** XMTP conversation id (stable key + read-state key; `useGroup`'s argument). */
  id: string;
  /** Group name and image from the group's metadata ('' when unset). */
  name: string;
  imageUrl: string;
  /** What the newest message is; the host renders it into copy. */
  last: MessageDescription;
  /**
   * Primary Ethereum address (lowercased) of whoever sent the newest message,
   * for a "Name: preview" row — null when there is no message, it is mine, or
   * the sender can't be resolved.
   */
  lastSenderAddress: string | null;
  /** sentNs of the most recent message (0 if none) — also the sort key. */
  lastSentNs: number;
  /** True when the newest message is from another member and unread. */
  unread: boolean;
}

export type InboxSummary = ConversationSummary | GroupConversationSummary;

export interface UseConversationsOptions {
  /** Merge the groups this inbox belongs to into the list. */
  includeGroups?: boolean;
}

export interface UseConversationsResult<S = ConversationSummary> {
  conversations: S[];
  isLoading: boolean;
  /** False when the active wallet has no usable XMTP client on this network. */
  clientAvailable: boolean;
  /** True only during a pull-to-refresh (drives RefreshControl). */
  refreshing: boolean;
  /** Pull-to-refresh: reloads and shows the RefreshControl spinner. */
  refresh: () => void;
  /** Silent reload (e.g. on screen focus) — no spinner. */
  reload: () => void;
}

/** Resolve sender/peer inbox ids to their primary Ethereum address in one call. */
async function resolveAddresses(
  client: Client,
  inboxIds: InboxId[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (inboxIds.length === 0) return map;
  try {
    const states = await client.inboxStates(false, inboxIds);
    for (const s of states) {
      const identities = s.identities ?? [];
      const eth = identities.find((i) => i.kind === 'ETHEREUM') ?? identities[0];
      if (eth?.identifier) map.set(s.inboxId, eth.identifier.toLowerCase());
    }
  } catch {
    // best-effort — unresolved peers are dropped from the list
  }
  return map;
}

const CONSENT: ConsentState[] = ['allowed', 'unknown'];

export function useConversations(): UseConversationsResult;
export function useConversations(options: { includeGroups: true }): UseConversationsResult<InboxSummary>;
export function useConversations(options?: UseConversationsOptions): UseConversationsResult<InboxSummary>;
export function useConversations(options?: UseConversationsOptions): UseConversationsResult<InboxSummary> {
  const includeGroups = !!options?.includeGroups;
  const [conversations, setConversations] = useState<InboxSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [clientAvailable, setClientAvailable] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setRefreshing(true);
    const client = getActiveXmtpClient();
    if (!client) {
      // Right after sign-in the client is still being created. Stay in the
      // loading state (not "unavailable") and wait for the lifecycle
      // subscription below to fire `reload` once it's ready.
      if (isXmtpClientInitializing()) {
        setIsLoading(true);
        setRefreshing(false);
        return;
      }
      setClientAvailable(false);
      setConversations([]);
      setIsLoading(false);
      setRefreshing(false);
      return;
    }
    setClientAvailable(true);
    const myInboxId = client.inboxId;
    try {
      await client.conversations.syncAllConversations();
      // Positional args: (opts, limit, consentStates, …, orderBy). opts must set
      // `lastMessage: true` or the returned DMs carry no lastMessage to preview;
      // middle window filters left undefined; order by most recent activity.
      const [dms, groups] = await Promise.all([
        client.conversations.listDms(
          { lastMessage: true }, undefined, CONSENT, undefined, undefined, undefined, undefined, 'last_activity',
        ),
        includeGroups
          ? client.conversations.listGroups(
              { lastMessage: true, name: true, imageUrl: true }, undefined, CONSENT,
              undefined, undefined, undefined, undefined, 'last_activity',
            )
          : Promise.resolve([]),
      ]);
      const peerIds = await Promise.all(dms.map((d) => d.peerInboxId()));
      // One inboxStates call covers DM peers and group last-senders alike.
      const groupSenderIds = groups.flatMap((g) =>
        g.lastMessage && g.lastMessage.senderInboxId !== myInboxId ? [g.lastMessage.senderInboxId] : [],
      );
      const addrByInbox = await resolveAddresses(client, [...new Set([...peerIds, ...groupSenderIds])]);

      const summaries: InboxSummary[] = [];
      dms.forEach((dm, i) => {
        const peerAddress = addrByInbox.get(peerIds[i]);
        if (!peerAddress) return; // can't render a row without an address
        const last = dm.lastMessage;
        // Text describes as itself; a card describes with its own preview or
        // wire fallback; MLS system messages and un-reactions describe as
        // `none` (so they light neither a junk preview nor a phantom unread dot).
        const lastSentNs = last?.sentNs ?? 0;
        const fromCounterparty = !!last && last.senderInboxId !== myInboxId;
        const description = describeMessage(last, { fromMe: !!last && !fromCounterparty });
        summaries.push({
          kind: 'dm',
          id: dm.id,
          peerAddress,
          last: description,
          lastSentNs,
          unread: isPreviewable(description) && fromCounterparty && lastSentNs > getLastReadNs(dm.id),
        });
      });
      for (const g of groups) {
        const last = g.lastMessage;
        const lastSentNs = last?.sentNs ?? 0;
        const fromOther = !!last && last.senderInboxId !== myInboxId;
        const description = describeMessage(last, { fromMe: !!last && !fromOther });
        summaries.push({
          kind: 'group',
          id: g.id,
          name: g.groupName ?? '',
          imageUrl: g.groupImageUrl ?? '',
          last: description,
          lastSenderAddress: fromOther ? addrByInbox.get(last!.senderInboxId) ?? null : null,
          lastSentNs,
          unread: isPreviewable(description) && fromOther && lastSentNs > getLastReadNs(g.id),
        });
      }
      summaries.sort((a, b) => b.lastSentNs - a.lastSentNs);
      setConversations(summaries);
    } catch (err: any) {
      console.warn('[xmtp] useConversations load failed', err?.message ?? err);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [includeGroups]);

  const refresh = useCallback(() => {
    load(true);
  }, [load]);

  const reload = useCallback(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    load(false);
  }, [load]);

  // Re-run when the XMTP client lifecycle changes (becomes ready after sign-in,
  // or is dropped/failed) so the host's inbox view self-heals without needing a re-focus.
  useEffect(() => subscribeXmtpClient(() => load(false)), [load]);

  // Keep closed-app push coverage in sync with the conversation list: the
  // host's startup push registration only subscribes to topics that existed
  // at connect time, so a conversation created later wouldn't push until the
  // next reconnect. Re-subscribe (debounced) whenever the count changes — this
  // only touches XMTP topics, no
  // permission prompt or wallet-reg POST.
  useEffect(() => {
    if (conversations.length === 0) return;
    const client = getActiveXmtpClient();
    if (!client) return;
    const t = setTimeout(() => {
      subscribeConversationTopics(client).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [conversations.length]);

  return { conversations, isLoading, clientAvailable, refreshing, refresh, reload };
}
