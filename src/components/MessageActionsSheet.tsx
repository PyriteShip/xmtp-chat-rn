import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { QUICK_REACTIONS } from '../chatReactions';
import { chatTheme, type ChatTheme } from '../theme';

/** What a long-press offers for the message it was fired on. */
export interface MessageActionsTarget {
  /** Network message id — what a reply quotes and a reaction references. */
  id: string;
  /** The message reduced to one line, shown at the top of the sheet. */
  preview: string;
  /** Emoji the signed-in user currently holds on this message, if any. */
  myEmoji: string | null;
  /** Plain text to copy, or null for a card with nothing quotable to copy. */
  copyText: string | null;
}

/**
 * Signal's long-press menu, as a bottom sheet.
 *
 * The quick-reaction row sits on top — six emoji, one tap each — with the one
 * you already hold shown as selected so a second tap reads as "take it back."
 * Signal anchors this row to the message itself; anchoring here would fight the
 * inverted list's cell geometry for no gain, so the sheet carries a one-line
 * echo of the message instead to keep the target unambiguous.
 */
export function MessageActionsSheet({
  target,
  onClose,
  onReact,
  onReply,
  onCopy,
  quickReactions = QUICK_REACTIONS,
  labels,
}: {
  /** The message being acted on; null closes the sheet. */
  target: MessageActionsTarget | null;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  /**
   * The emoji offered in the quick row. Defaults to Signal's six; the row is
   * laid out with `space-between`, so a longer set crowds it rather than
   * scrolling — keep it to roughly six.
   */
  quickReactions?: readonly string[];
  /** Labels and accessibility strings. English defaults; the host supplies its own translated copy. */
  labels?: {
    /** Backdrop tap target that dismisses the sheet. */
    close?: string;
    /** The sheet itself. */
    sheet?: string;
    /** The reply row. */
    reply?: string;
    /** The copy row. */
    copy?: string;
    /** A quick-reaction slot not currently held by the signed-in user. */
    reactionAdd?: (emoji: string) => string;
    /** A quick-reaction slot currently held by the signed-in user. */
    reactionRemove?: (emoji: string) => string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const {
    close = 'Close',
    sheet = 'Message actions',
    reply = 'Reply',
    copy = 'Copy',
    reactionAdd = (emoji: string) => `React with ${emoji}`,
    reactionRemove = (emoji: string) => `Remove your ${emoji} reaction`,
  } = labels ?? {};
  return (
    <Modal
      visible={target !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={close}>
        {/* Inner press swallows taps so using the sheet doesn't dismiss it. */}
        <Pressable
          style={styles.sheet}
          onPress={() => {}}
          accessibilityLabel={sheet}
        >
          <View style={styles.grabber} />

          <View style={styles.reactionBar}>
            {quickReactions.map((emoji) => {
              const mine = target?.myEmoji === emoji;
              return (
                <Pressable
                  key={emoji}
                  style={[styles.reactionSlot, mine && styles.reactionSlotMine]}
                  onPress={() => onReact(emoji)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: mine }}
                  accessibilityLabel={mine ? reactionRemove(emoji) : reactionAdd(emoji)}
                >
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                </Pressable>
              );
            })}
          </View>

          {target?.preview ? (
            <Text style={styles.preview} numberOfLines={1}>
              {target.preview}
            </Text>
          ) : null}

          <Pressable style={styles.action} onPress={onReply} accessibilityRole="button">
            <Icon name="reply" size={20} color={theme.colors.text} />
            <Text style={styles.actionText}>{reply}</Text>
          </Pressable>

          {/* Only text can be copied — a card has no body to put on the clipboard. */}
          {target?.copyText ? (
            <Pressable style={styles.action} onPress={onCopy} accessibilityRole="button">
              <Icon name="content-copy" size={20} color={theme.colors.text} />
              <Text style={styles.actionText}>{copy}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.colors.surface,
    borderTopLeftRadius: t.radius.lg,
    borderTopRightRadius: t.radius.lg,
    padding: t.spacing.lg,
    paddingBottom: t.spacing.xl,
    gap: t.spacing.xs,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.colors.border,
    marginBottom: t.spacing.sm,
  },
  reactionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: t.colors.fill,
    borderRadius: t.radius.pill,
    padding: t.spacing.xs,
  },
  reactionSlot: {
    width: 44,
    height: 44,
    borderRadius: t.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionSlotMine: { backgroundColor: t.colors.accentSoft },
  reactionEmoji: { fontSize: 24 },
  preview: {
    ...t.text.bodySmall,
    color: t.colors.textMuted,
    paddingHorizontal: t.spacing.xs,
    paddingTop: t.spacing.sm,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.xs,
  },
  actionText: { ...t.text.body, color: t.colors.text },
  });
}
