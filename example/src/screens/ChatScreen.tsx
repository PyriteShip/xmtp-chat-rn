/**
 * The thread. Everything below comes out of one hook call.
 *
 * `useConversation` returns the messages newest-first (an inverted FlatList
 * wants them that way), an optimistic `send` that never rejects — a failure
 * shows up as delivery state on the bubble instead — plus reactions, replies
 * and the reachability answer for the address you are typing at.
 *
 * The screen shell, the bubble bodies and the copy are all the host's. What
 * the package draws is the furniture: swipe-to-reply, reaction pills, the
 * actions sheet, the scroll-to-latest pill.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {
  MessageActionsSheet,
  QuotedMessage,
  ReactionPills,
  ScrollToLatest,
  SwipeToReply,
  myReaction,
  sendCard,
  summarizeReactions,
  useConversation,
  type MessageActionsTarget,
} from 'xmtp-chat-rn';
import * as Clipboard from 'expo-clipboard';
import { MessageBubble } from '../components/MessageBubble';
import { messageSummary, type ExampleChatMessage } from '../messages';
import { nudgeCard } from '../nudge';
import { colors, radius, spacing } from '../theme';

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ChatScreen({
  peerAddress,
  onBack,
}: {
  peerAddress: string;
  onBack: () => void;
}) {
  const {
    messages,
    isReachable,
    clientAvailable,
    isLoading,
    initError,
    retryInit,
    send,
    retryMessage,
    discardFailed,
    reactions,
    myInboxId,
    toggleReaction,
  } = useConversation<ExampleChatMessage>(peerAddress);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ExampleChatMessage | null>(null);
  const [actionsTarget, setActionsTarget] = useState<ExampleChatMessage | null>(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  // Newest message the user has actually had on screen — the baseline the
  // "N new" badge counts from.
  const seenNsRef = useRef(0);
  const listRef = useRef<FlatList<ExampleChatMessage>>(null);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const newestNs = messages[0]?.sentNs ?? 0;
  if (!awayFromLatest) seenNsRef.current = newestNs;
  const unseen = messages.filter((m) => m.sentNs > seenNsRef.current).length;

  const canSend = clientAvailable && isReachable !== false;

  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const replyToId = replyTo?.id;
    setReplyTo(null);
    // Deliberately not awaited: the optimistic bubble is already in the list,
    // and a failure lands on it rather than here.
    void send(text, replyToId);
  }, [draft, replyTo, send]);

  const onNudge = useCallback(() => {
    void sendCard(peerAddress, nudgeCard, { note: 'Ping — are you there?' });
  }, [peerAddress]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Inverted list: offset 0 is the newest message.
    setAwayFromLatest(e.nativeEvent.contentOffset.y > 240);
  }, []);

  // The sheet needs the message reduced to a line, plus which emoji is already
  // yours, so an existing reaction renders as "remove" rather than "add".
  const sheetTarget: MessageActionsTarget | null = useMemo(() => {
    if (!actionsTarget) return null;
    return {
      id: actionsTarget.id,
      preview: messageSummary(actionsTarget),
      myEmoji: myReaction(reactions.get(actionsTarget.id) ?? [], myInboxId),
      copyText: actionsTarget.kind === 'text' ? actionsTarget.text : null,
    };
  }, [actionsTarget, reactions, myInboxId]);

  const renderItem = useCallback(
    ({ item }: { item: ExampleChatMessage }) => {
      // An optimistic copy has no network id yet, so it cannot be the target of
      // a reply or a reaction until the ack lands.
      const addressable = !(item.kind === 'text' && item.delivery);
      const quoted =
        item.kind === 'text' && item.replyToId ? byId.get(item.replyToId) : undefined;

      return (
        <View style={styles.item}>
          <SwipeToReply enabled={addressable} onReply={() => setReplyTo(item)}>
            <MessageBubble
              message={item}
              quoted={
                quoted
                  ? { author: quoted.fromMe ? 'You' : short(peerAddress), preview: messageSummary(quoted) }
                  : item.kind === 'text' && item.replyToId
                    ? // The quoted message is outside the loaded window. Saying
                      // so beats dropping the quote and leaving the reply
                      // looking like an unprompted remark.
                      { author: '', preview: 'Original message unavailable' }
                    : undefined
              }
              onLongPress={addressable ? () => setActionsTarget(item) : undefined}
              onRetry={() => void retryMessage(item)}
              onDiscard={() => discardFailed(item.id)}
            />
          </SwipeToReply>
          <ReactionPills
            reactions={summarizeReactions(reactions.get(item.id) ?? [], myInboxId)}
            align={item.fromMe ? 'right' : 'left'}
            onToggle={(emoji) => void toggleReaction(item.id, emoji)}
          />
        </View>
      );
    },
    [byId, peerAddress, reactions, myInboxId, retryMessage, discardFailed, toggleReaction],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹ Inbox</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{short(peerAddress)}</Text>
        <View style={styles.back} />
      </View>

      {/* Reachability is the counterparty's problem, not ours: an address with
          no XMTP inbox cannot receive anything, and saying so is kinder than a
          send that silently goes nowhere. */}
      {isReachable === false ? (
        <Text style={styles.banner}>
          This address has no XMTP inbox on the dev network yet, so it cannot receive messages.
        </Text>
      ) : null}

      {initError ? (
        <TouchableOpacity style={styles.banner} onPress={retryInit}>
          <Text style={styles.bannerText}>Could not open this thread. Tap to retry.</Text>
        </TouchableOpacity>
      ) : null}

      {isLoading && messages.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <View style={styles.listWrap}>
          <FlatList
            ref={listRef}
            data={messages}
            inverted
            keyExtractor={(m) => m.id}
            renderItem={renderItem}
            onScroll={onScroll}
            scrollEventThrottle={64}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.empty}>No messages yet. Say something.</Text>}
          />
          <ScrollToLatest
            visible={awayFromLatest}
            unseen={unseen}
            onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          />
        </View>
      )}

      {replyTo ? (
        <View style={styles.replyBar}>
          <QuotedMessage
            author={replyTo.fromMe ? 'You' : short(peerAddress)}
            preview={messageSummary(replyTo)}
            tone="composer"
            onDismiss={() => setReplyTo(null)}
          />
        </View>
      ) : null}

      <View style={styles.composer}>
        <TouchableOpacity
          style={styles.nudgeButton}
          onPress={onNudge}
          disabled={!canSend}
          accessibilityLabel="Send a nudge"
        >
          <Text style={styles.nudgeText}>👋</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.textMuted}
          editable={canSend}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, (!draft.trim() || !canSend) && styles.sendDisabled]}
          onPress={onSend}
          disabled={!draft.trim() || !canSend}
        >
          <Text style={styles.sendText}>Send</Text>
        </TouchableOpacity>
      </View>

      <MessageActionsSheet
        target={sheetTarget}
        onClose={() => setActionsTarget(null)}
        onReact={(emoji) => actionsTarget && void toggleReaction(actionsTarget.id, emoji)}
        onReply={() => actionsTarget && setReplyTo(actionsTarget)}
        onCopy={() => sheetTarget?.copyText && Clipboard.setStringAsync(sheetTarget.copyText)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { width: 72 },
  backText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  banner: {
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    fontSize: 13,
  },
  bannerText: { color: colors.danger, fontSize: 13 },
  listWrap: { flex: 1 },
  listContent: { paddingVertical: spacing.md },
  item: { gap: spacing.xs, paddingBottom: spacing.sm },
  loading: { marginTop: spacing.xl },
  empty: {
    color: colors.textMuted,
    textAlign: 'center',
    paddingTop: spacing.xl,
    transform: [{ scaleY: -1 }],
  },
  replyBar: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  nudgeButton: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
  nudgeText: { fontSize: 22 },
  input: {
    flex: 1,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.fill,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.onAccent, fontWeight: '600' },
});
