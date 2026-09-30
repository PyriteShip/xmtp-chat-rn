/**
 * A group thread. `useGroup` is `useConversation` for a group: the same
 * newest-first messages, reaction map, optimistic `send`, retry, discard and
 * reaction toggle — so this screen reuses `MessageBubble` and every shipped
 * component the DM screen does.
 *
 * What a group adds is authorship and membership. A message names its sender
 * only by inbox id; `members` maps that to an address (a real app would map
 * the address on to a contact name). The Members panel is the management
 * surface: `addGroupMembers`, `removeGroupMembers`, `updateGroup` and
 * `leaveGroup`. None of them touches this screen's state — each change lands
 * in the group as an update, and `useGroup` re-reads `name` and `members`.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  MessageActionsSheet,
  QuotedMessage,
  ReactionPills,
  SwipeToReply,
  UnreachableMembersError,
  addGroupMembers,
  leaveGroup,
  myReaction,
  removeGroupMembers,
  summarizeReactions,
  updateGroup,
  useGroup,
  type GroupMember,
  type MessageActionsTarget,
} from 'xmtp-chat-rn';
import { useKeyboardHeight } from '../useKeyboardHeight';
import { MessageBubble } from '../components/MessageBubble';
import { messageSummary, type ExampleChatMessage } from '../messages';
import { colors, radius, spacing } from '../theme';

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Say what went wrong in a member change, in words a person can act on. */
function describeError(err: any): string {
  if (err instanceof UnreachableMembersError) return `No XMTP inbox yet: ${err.addresses.map(short).join(', ')}`;
  return err?.message ?? 'Something went wrong.';
}

/**
 * Members, rename and leave. Every call is fire-and-report: success shows up
 * through `useGroup` re-reading the group, so only failure needs handling here.
 */
function MembersPanel({
  groupId,
  name,
  members,
  onLeft,
}: {
  groupId: string;
  name: string;
  members: GroupMember[];
  onLeft: () => void;
}) {
  const [newMember, setNewMember] = useState('');
  const [newName, setNewName] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  return (
    <View style={styles.panel}>
      {members.map((m) => (
        <View key={m.inboxId} style={styles.memberRow}>
          <Text style={styles.memberText}>
            {m.isMe ? 'You' : short(m.address)}
            {m.role !== 'member' ? ` · ${m.role.replace('_', ' ')}` : ''}
          </Text>
          {!m.isMe ? (
            <TouchableOpacity onPress={() => void run(() => removeGroupMembers(groupId, [m.address]))}>
              <Text style={styles.remove}>Remove</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ))}
      <View style={styles.panelRow}>
        <TextInput
          style={styles.panelInput}
          value={newMember}
          onChangeText={setNewMember}
          placeholder="0x… address to add"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[styles.panelButton, !ADDRESS.test(newMember.trim()) && styles.sendDisabled]}
          disabled={!ADDRESS.test(newMember.trim())}
          onPress={() => void run(async () => {
            await addGroupMembers(groupId, [newMember.trim()]);
            setNewMember('');
          })}
        >
          <Text style={styles.sendText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.panelRow}>
        <TextInput
          style={styles.panelInput}
          value={newName}
          onChangeText={setNewName}
          placeholder="Group name"
          placeholderTextColor={colors.textMuted}
        />
        <TouchableOpacity
          style={[styles.panelButton, (!newName.trim() || newName === name) && styles.sendDisabled]}
          disabled={!newName.trim() || newName === name}
          onPress={() => void run(() => updateGroup(groupId, { name: newName.trim() }))}
        >
          <Text style={styles.sendText}>Rename</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={() => void run(async () => { await leaveGroup(groupId); onLeft(); })}>
        <Text style={styles.leave}>Leave group</Text>
      </TouchableOpacity>
      {error ? <Text style={styles.panelError}>{error}</Text> : null}
    </View>
  );
}

export function GroupScreen({ groupId, onBack }: { groupId: string; onBack: () => void }) {
  const {
    messages,
    reactions,
    myInboxId,
    name,
    members,
    isLoading,
    notFound,
    initError,
    retryInit,
    send,
    retryMessage,
    discardFailed,
    toggleReaction,
  } = useGroup<ExampleChatMessage>(groupId);
  const [showMembers, setShowMembers] = useState(false);
  const labels = useMemo(
    () => new Map(members.map((m) => [m.inboxId, short(m.address)])),
    [members],
  );
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ExampleChatMessage | null>(null);
  const [actionsTarget, setActionsTarget] = useState<ExampleChatMessage | null>(null);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const author = useCallback(
    (m: ExampleChatMessage) => (m.fromMe ? 'You' : labels.get(m.senderInboxId) ?? 'Former member'),
    [labels],
  );

  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const replyToId = replyTo?.id;
    setReplyTo(null);
    // Not awaited, as in the DM screen: a failure lands on the bubble.
    void send(text, replyToId);
  }, [draft, replyTo, send]);

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
      const addressable = !((item.kind === 'text' || item.kind === 'attachment') && item.delivery);
      const quoted =
        item.kind === 'text' && item.replyToId ? byId.get(item.replyToId) : undefined;
      return (
        <View style={styles.item}>
          {!item.fromMe ? <Text style={styles.sender}>{author(item)}</Text> : null}
          <SwipeToReply enabled={addressable} onReply={() => setReplyTo(item)}>
            <MessageBubble
              message={item}
              quoted={
                quoted
                  ? { author: author(quoted), preview: messageSummary(quoted) }
                  : item.kind === 'text' && item.replyToId
                    ? { author: '', preview: 'Original message unavailable' }
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
    [byId, author, reactions, myInboxId, retryMessage, discardFailed, toggleReaction],
  );

  return (
    <View style={[styles.container, { paddingBottom: keyboardHeight || insets.bottom }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹ Inbox</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {name || 'Unnamed group'}
        </Text>
        <TouchableOpacity style={styles.back} onPress={() => setShowMembers((v) => !v)} disabled={notFound}>
          <Text style={[styles.backText, styles.membersToggle]}>
            {showMembers ? 'Done' : `${members.length} 👥`}
          </Text>
        </TouchableOpacity>
      </View>

      {showMembers ? (
        <MembersPanel groupId={groupId} name={name} members={members} onLeft={onBack} />
      ) : null}

      {notFound ? <Text style={styles.banner}>This group is not on this device.</Text> : null}
      {initError ? (
        <TouchableOpacity style={styles.bannerWrap} onPress={retryInit}>
          <Text style={styles.bannerText}>Could not open this group. Tap to retry.</Text>
        </TouchableOpacity>
      ) : null}

      {isLoading && messages.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={messages}
          inverted
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={<Text style={styles.empty}>No messages yet. Say something.</Text>}
        />
      )}

      {replyTo ? (
        <View style={styles.replyBar}>
          <QuotedMessage
            author={author(replyTo)}
            preview={messageSummary(replyTo)}
            tone="composer"
            onDismiss={() => setReplyTo(null)}
          />
        </View>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message the group"
          placeholderTextColor={colors.textMuted}
          editable={!notFound}
          multiline
        />
        <TouchableOpacity
          style={[styles.send, (!draft.trim() || notFound) && styles.sendDisabled]}
          onPress={onSend}
          disabled={!draft.trim() || notFound}
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
    </View>
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
  membersToggle: { textAlign: 'right' },
  panel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.fill,
  },
  memberRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memberText: { color: colors.text, fontSize: 14 },
  remove: { color: colors.danger, fontSize: 13 },
  panelRow: { flexDirection: 'row', gap: spacing.sm },
  panelInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  panelButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  leave: { color: colors.danger, fontSize: 14, fontWeight: '600', paddingTop: spacing.xs },
  panelError: { color: colors.danger, fontSize: 13 },
  title: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 16, fontWeight: '600' },
  banner: {
    backgroundColor: colors.dangerSoft,
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    fontSize: 13,
  },
  bannerWrap: {
    backgroundColor: colors.dangerSoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bannerText: { color: colors.danger, fontSize: 13 },
  listContent: { paddingVertical: spacing.md },
  item: { gap: spacing.xs, paddingBottom: spacing.sm },
  sender: { color: colors.textMuted, fontSize: 12, paddingHorizontal: spacing.lg },
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
