import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { chatTheme, type ChatTheme } from '../theme';
import type { ReactionSummary } from '../chatReactions';

/**
 * The reaction tally under a bubble: one pill per emoji, filled when it is
 * yours. Tapping a pill toggles your own reaction on that emoji — the same
 * `toggleReaction` the long-press bar calls, so the two entry points can't
 * disagree about what a tap means.
 *
 * The row aligns with its bubble (`align`) and overlaps it slightly, so the
 * pills read as attached to the message rather than as a row of their own.
 */
export function ReactionPills({
  reactions,
  align,
  onToggle,
  labels,
}: {
  reactions: readonly ReactionSummary[];
  align: 'left' | 'right';
  onToggle: (emoji: string) => void;
  /** Accessibility labels. English defaults; the host supplies its own translated copy. */
  labels?: {
    /** A pill not currently held by the signed-in user. */
    reactionAdd?: (emoji: string) => string;
    /** A pill currently held by the signed-in user. */
    reactionRemove?: (emoji: string) => string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const {
    reactionAdd = (emoji: string) => `React with ${emoji}`,
    reactionRemove = (emoji: string) => `Remove your ${emoji} reaction`,
  } = labels ?? {};
  if (reactions.length === 0) return null;
  return (
    <View style={[styles.row, align === 'right' ? styles.right : styles.left]}>
      {reactions.map((r) => (
        <TouchableOpacity
          key={r.emoji}
          style={[styles.pill, r.mine && styles.pillMine]}
          onPress={() => onToggle(r.emoji)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ selected: r.mine }}
          accessibilityLabel={r.mine ? reactionRemove(r.emoji) : reactionAdd(r.emoji)}
        >
          <Text style={styles.emoji}>{r.emoji}</Text>
          {/* A lone reactor needs no tally — the pill already says "one". */}
          {r.count > 1 ? <Text style={[styles.count, r.mine && styles.countMine]}>{r.count}</Text> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: t.spacing.xs,
    // Pulls the pills up onto the bubble's lower edge (Signal's overlap).
    marginTop: -6,
    paddingHorizontal: t.spacing.xs,
  },
  left: { justifyContent: 'flex-start' },
  right: { justifyContent: 'flex-end' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
  },
  pillMine: { backgroundColor: t.colors.accentSoft, borderColor: t.colors.accent },
  emoji: { fontSize: 13 },
  count: { fontSize: 11, fontWeight: '700', color: t.colors.textSoft, fontVariant: ['tabular-nums'] },
  countMine: { color: t.colors.accent },
  });
}
