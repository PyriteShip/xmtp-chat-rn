/**
 * Group thread hook, the group counterpart of `useConversation`.
 *
 * Attaches to an existing XMTP group by id, loads history, and live-streams
 * new messages, returning the same newest-first `messages` and `reactions`
 * shapes so a host renders a group with the bubbles it already has. Each
 * message carries `senderInboxId`; resolving that to a display name is the
 * host's (see `resolveSenderAddress`).
 *
 * Sending is `useConversation`'s own machinery (see threadSend.ts): optimistic
 * text, replies and attachments with delivery state, retry, discard, and
 * reaction toggling, all with the same contracts.
 *
 * No read receipts, either way. Viewing advances only the LOCAL read
 * watermark, so the inbox unread dot clears; nothing is sent. Receipts from
 * members are dropped rather than applied — a single "read" tick on my
 * message can't say which of several members read it, so group bubbles never
 * reach `delivery: 'read'`. A group is never created here: an id this
 * installation doesn't hold reports `notFound`, and a send to it fails its
 * bubble.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Group, InboxId } from '@xmtp/react-native-sdk';
import type { LocalAttachmentFile } from './attachments';
import { getActiveXmtpClient, isXmtpClientInitializing, subscribeXmtpClient } from './client';
import { markRead } from './readState';
import { isReadReceipt } from './readReceipt';
import { groupReactions, mergeReaction, type ReactionEvent } from './chatReactions';
import { mergeStreamed } from './deliveryState';
import { useThreadSend, type SendTarget } from './threadSend';
import { toGroupMembers, type GroupMember } from './groups';

/** An MLS membership/metadata change: never a bubble, but the group's info moved. */
function isGroupUpdate(m: { contentTypeId?: string }): boolean {
  return (m.contentTypeId ?? '').startsWith('xmtp.org/group_updated:');
}
import {
  foldHistory,
  loadHistory,
  toChatMessage,
  toReactionEvent,
  type AnyChatMessage,
  type ChatMessageBase,
} from './useConversation';

export interface UseGroupResult<M extends ChatMessageBase & { kind: string }> {
  messages: M[];
  /** Reaction events per target message id — fold with `summarizeReactions`. */
  reactions: ReadonlyMap<string, ReactionEvent[]>;
  /** Our own inbox id, so the fold can mark which pills are ours. */
  myInboxId: InboxId | null;
  /** Group name and image as the group's metadata holds them ('' when unset). */
  name: string;
  imageUrl: string;
  /**
   * Members as last synced, me included. Re-read whenever a membership or
   * metadata change lands (see groups.ts), so it stays current while open.
   */
  members: GroupMember[];
  isLoading: boolean;
  /** False when the active wallet has no usable XMTP client on this network. */
  clientAvailable: boolean;
  /** This installation holds no group with this id (never joined, or removed from it before sync). */
  notFound: boolean;
  /** The init (lookup / history load / stream attach) threw; `retryInit` re-runs it. */
  initError: boolean;
  retryInit: () => void;
  /** Optimistic send, as `useConversation`'s: never rejects; a failure shows on the bubble. */
  send: (text: string, replyToId?: string) => Promise<void>;
  /** Optimistic attachment send, as `useConversation`'s (same two rejections). */
  sendAttachment: (file: LocalAttachmentFile) => Promise<void>;
  /** Re-deliver a `failed` message, or publish an `unpublished` one now. */
  retryMessage: (message: M) => Promise<void>;
  /** Drop a `failed` message locally (see `useConversation`'s caveat). */
  discardFailed: (id: string) => void;
  /** Signal's one-reaction-per-person toggle, optimistic, reverting on failure. */
  toggleReaction: (targetId: string, emoji: string) => Promise<void>;
}

export function useGroup<M extends ChatMessageBase & { kind: string }>(
  groupId: string,
): UseGroupResult<M> {
  const [messages, setMessages] = useState<AnyChatMessage[]>([]);
  const [reactions, setReactions] = useState<ReadonlyMap<string, ReactionEvent[]>>(new Map());
  const [myInboxId, setMyInboxId] = useState<InboxId | null>(null);
  const [name, setName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [clientAvailable, setClientAvailable] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [initError, setInitError] = useState(false);
  // Same lifecycle re-run as useConversation: a mount before the client is
  // ready must self-heal when it comes up rather than latch "unavailable".
  const [clientTick, setClientTick] = useState(0);
  useEffect(() => subscribeXmtpClient(() => setClientTick((t) => t + 1)), []);
  const groupRef = useRef<Group<any> | null>(null);
  const myInboxIdRef = useRef<InboxId | null>(null);
  // Mirrors `reactions` so the stream handler folds onto the current map.
  const reactionsRef = useRef<ReadonlyMap<string, ReactionEvent[]>>(new Map());
  const applyReactions = useCallback((next: ReadonlyMap<string, ReactionEvent[]>) => {
    reactionsRef.current = next;
    setReactions(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    setMessages([]);
    applyReactions(new Map());
    setMembers([]);
    setIsLoading(true);
    setClientAvailable(true);
    setNotFound(false);
    setInitError(false);

    (async () => {
      const client = getActiveXmtpClient();
      if (!client) {
        if (isXmtpClientInitializing()) return;
        if (!cancelled) {
          setClientAvailable(false);
          setIsLoading(false);
        }
        return;
      }
      const me = client.inboxId;
      myInboxIdRef.current = me;
      setMyInboxId(me);
      const group = (await client.conversations.findGroup(groupId as any)) as Group<any> | undefined;
      if (cancelled) return;
      if (!group) {
        setNotFound(true);
        setIsLoading(false);
        return;
      }
      groupRef.current = group;
      setName(group.groupName ?? '');
      setImageUrl(group.groupImageUrl ?? '');
      // Best-effort: a group whose info can't be read still opens.
      const loadMembers = async () => {
        try {
          const list = await group.members();
          if (!cancelled) setMembers(toGroupMembers(list, me));
        } catch (err: any) {
          console.warn('[xmtp] group members unavailable', err?.message ?? err);
        }
      };
      const refreshInfo = async () => {
        // Settled separately so one unreadable field doesn't hide the other.
        const [n, img] = await Promise.allSettled([group.name(), group.imageUrl()]);
        if (cancelled) return;
        if (n.status === 'fulfilled') setName(n.value ?? '');
        if (img.status === 'fulfilled') setImageUrl(img.value ?? '');
        await loadMembers();
      };
      await group.sync();
      void loadMembers();
      const history = await loadHistory(group);
      if (cancelled) return;
      const { mapped, events } = foldHistory(history, me);
      setMessages(mapped);
      applyReactions(groupReactions(events));
      if (history.length > 0) {
        markRead(group.id, history.reduce((max, m) => Math.max(max, m.sentNs), 0));
      }
      setIsLoading(false);

      const stop = await group.streamMessages(async (m) => {
        if (cancelled) return;
        if (isReadReceipt(m)) return;
        if (isGroupUpdate(m)) {
          void refreshInfo();
          return;
        }
        markRead(group.id, m.sentNs); // arriving while the thread is open = read
        const event = toReactionEvent(m);
        if (event) {
          applyReactions(mergeReaction(reactionsRef.current, event));
          return;
        }
        const cm = toChatMessage(m, me);
        if (cm) setMessages((prev) => mergeStreamed(prev, cm));
      });
      if (cancelled) {
        try { stop(); } catch {}
        return;
      }
      unsub = stop;
    })().catch((err) => {
      console.warn('[xmtp] useGroup init failed', err?.message ?? err);
      if (!cancelled) {
        setInitError(true);
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
      groupRef.current = null;
      if (unsub) {
        try { unsub(); } catch {}
      }
    };
  }, [groupId, clientTick, applyReactions]);

  const retryInit = useCallback(() => setClientTick((t) => t + 1), []);

  // A group is joined, never created here, so the only thread to send into is
  // the attached one.
  const prepare = useCallback(async (): Promise<SendTarget> => {
    const group = groupRef.current;
    if (!group) throw new Error('Group not available');
    return group;
  }, []);
  const current = useCallback(() => groupRef.current, []);
  const { send, sendAttachment, retryMessage, discardFailed, toggleReaction } = useThreadSend<M>({
    prepare,
    current,
    myInboxIdRef,
    setMessages,
    reactionsRef,
    applyReactions,
  });

  return {
    messages: messages as unknown as M[],
    reactions,
    myInboxId,
    name,
    imageUrl,
    members,
    isLoading,
    clientAvailable,
    notFound,
    initError,
    retryInit,
    send,
    sendAttachment,
    retryMessage,
    discardFailed,
    toggleReaction,
  };
}
