import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { chatTheme, type ChatTheme } from '../theme';

/**
 * The line under a message that could not be sent: "Not delivered", tappable to
 * retry, with a discard control beside it.
 *
 * A failed send is the one delivery state the reader has to act on, so it is
 * stated rather than encoded in a glyph — `BubbleMeta` renders no glyph at all
 * for `failed` and defers to this. Both affordances are needed: retry alone
 * strands a message that will never send (a revoked installation, a peer with
 * no inbox), and discard alone loses text the sender may still want.
 *
 * The host draws the bubble, so it applies its own failed tint; `danger` and
 * `dangerSoft` are in the theme for exactly that.
 */
export function FailedNotice({
  onRetry,
  onDiscard,
  labels,
}: {
  /** Re-send the message. Also wire this to a press on the bubble itself. */
  onRetry: () => void;
  /** Drop the message from the thread. Irreversible; it was never sent. */
  onDiscard: () => void;
  /** English defaults; a host supplies its own translated copy. */
  labels?: {
    /** The tappable "Not delivered" line. */
    notDelivered?: string;
    /** Accessibility label for the discard control. */
    discard?: string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const { notDelivered = 'Not delivered · Tap to retry', discard = 'Discard message' } = labels ?? {};
  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={onRetry} accessibilityRole="button">
        <Text style={styles.text}>{notDelivered}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onDiscard}
        accessibilityRole="button"
        accessibilityLabel={discard}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Icon name="close-circle" size={15} color={theme.colors.danger} />
      </TouchableOpacity>
    </View>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs },
    text: { fontSize: 11, fontWeight: '600', color: t.colors.danger },
  });
}
