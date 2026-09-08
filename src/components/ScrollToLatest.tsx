import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { chatTheme, type ChatTheme } from '../theme';

/**
 * Signal's jump-to-latest button: appears once the thread is scrolled away from
 * the bottom, and carries a badge counting messages that arrived while you were
 * reading back. Without it, a long thread strands you with no way back and no
 * sign that anything new landed.
 */
export function ScrollToLatest({
  visible,
  unseen,
  onPress,
  labels,
}: {
  visible: boolean;
  /** Messages that arrived while scrolled away; 0 hides the badge. */
  unseen: number;
  onPress: () => void;
  /** Accessibility labels. English defaults; the host supplies its own translated (and pluralized) copy. */
  labels?: {
    /** No unseen messages. */
    scrollToLatest?: string;
    /** One or more unseen messages, given the count. */
    newMessages?: (count: number) => string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const {
    scrollToLatest = 'Scroll to latest',
    newMessages = (count: number) => `${count} new message${count === 1 ? '' : 's'}`,
  } = labels ?? {};
  if (!visible) return null;
  return (
    <TouchableOpacity
      style={styles.button}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={unseen > 0 ? newMessages(unseen) : scrollToLatest}
    >
      <Icon name="chevron-down" size={24} color={theme.colors.text} />
      {unseen > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unseen > 99 ? '99+' : unseen}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  button: {
    position: 'absolute',
    right: t.spacing.lg,
    bottom: t.spacing.md,
    width: 40,
    height: 40,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...t.shadow.lift,
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: t.colors.onAccent,
    fontVariant: ['tabular-nums'],
  },
  });
}
