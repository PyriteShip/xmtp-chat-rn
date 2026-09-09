/**
 * Inbox — every 1:1 conversation for the demo identity, most recent first,
 * plus the address bar you need to start one.
 *
 * `useConversations` returns rows, not copy: `last` is a `MessageDescription`
 * the host renders (see `previewText`), and `unread` is already folded against
 * the local read watermark. `useUnreadCount` is the same rule counted across
 * threads, for the badge a real app would put on a tab.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useConversations, useUnreadCount, type ConversationSummary } from 'xmtp-chat-rn';
import { previewText } from '../messages';
import { colors, radius, spacing } from '../theme';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function InboxScreen({
  address,
  onOpenChat,
  onRotateIdentity,
}: {
  address: string;
  onOpenChat: (peerAddress: string) => void;
  onRotateIdentity: () => void;
}) {
  const { conversations, isLoading, refreshing, refresh, reload } = useConversations();
  const unread = useUnreadCount();
  const [draft, setDraft] = useState('');
  const valid = ADDRESS.test(draft.trim());

  const open = useCallback(() => {
    if (!valid) return;
    onOpenChat(draft.trim().toLowerCase());
    setDraft('');
  }, [draft, valid, onOpenChat]);

  const renderRow = useCallback(
    ({ item }: { item: ConversationSummary }) => (
      <TouchableOpacity style={styles.row} onPress={() => onOpenChat(item.peerAddress)}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{short(item.peerAddress)}</Text>
          <Text style={styles.rowPreview} numberOfLines={1}>
            {previewText(item.last)}
          </Text>
        </View>
        {item.unread ? <View style={styles.dot} /> : null}
      </TouchableOpacity>
    ),
    [onOpenChat],
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text style={styles.label}>You are</Text>
          <TouchableOpacity onPress={() => Clipboard.setStringAsync(address)}>
            <Text style={styles.address}>{short(address)}</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>Tap to copy · dev network</Text>
        </View>
        <TouchableOpacity style={styles.rotate} onPress={onRotateIdentity}>
          <Text style={styles.rotateText}>New identity</Text>
        </TouchableOpacity>
      </View>

      {/* Both ends of a demo conversation are addresses you paste. Copy this
          one to a second device or simulator, or rotate to a new identity and
          message the address you just left. */}
      <View style={styles.composeRow}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="0x… address to message"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={open}
        />
        <TouchableOpacity
          style={[styles.go, !valid && styles.goDisabled]}
          onPress={open}
          disabled={!valid}
        >
          <Text style={styles.goText}>Open</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.listHeader}>
        <Text style={styles.listTitle}>Conversations</Text>
        {unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread}</Text>
          </View>
        ) : null}
      </View>

      {isLoading && conversations.length === 0 ? (
        <ActivityIndicator style={styles.loading} color={colors.accent} />
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          renderItem={renderRow}
          onLayout={reload}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No conversations yet. Paste an address above to start one.
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  identity: { gap: 2 },
  label: { color: colors.textMuted, fontSize: 12 },
  address: { color: colors.text, fontSize: 20, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12 },
  rotate: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rotateText: { color: colors.textSoft, fontSize: 13, fontWeight: '600' },
  composeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.fill,
  },
  go: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  goDisabled: { opacity: 0.4 },
  goText: { color: colors.onAccent, fontWeight: '600' },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
  },
  listTitle: { color: colors.textSoft, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  badgeText: { color: colors.onAccent, fontSize: 12, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowPreview: { color: colors.textMuted, fontSize: 13 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  loading: { marginTop: spacing.xl },
  empty: {
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
});
