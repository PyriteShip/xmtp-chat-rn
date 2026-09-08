import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { chatTheme, type ChatTheme } from '../theme';
import type { MessageDelivery } from '../deliveryState';

/**
 * The footer line inside a bubble: send time, plus a delivery glyph on your own
 * messages. Signal puts both in the bubble rather than only on a date divider,
 * so "when exactly did I send that" never needs a scroll to the nearest header.
 *
 * Glyphs track the three states the optimistic send pipeline produces (see
 * deliveryState.ts): a clock while in flight, one check on the network's ack,
 * two once the stream echoes the authoritative copy back. `failed` has its own,
 * louder treatment on the bubble ("Not delivered · Tap to retry") and is not
 * shown here.
 */
export function BubbleMeta({
  sentNs,
  fromMe,
  delivery,
  onAccent,
  locale,
  labels,
}: {
  sentNs: number;
  fromMe: boolean;
  /** Absent on a confirmed network message — that is the fully-delivered state. */
  delivery?: MessageDelivery;
  /** True inside an accent bubble, where the meta has to read on the accent. */
  onAccent: boolean;
  /** BCP-47 tag for the time format (appLocaleTag()). */
  locale: string;
  /** Accessibility labels for the delivery glyph. English defaults; the host supplies its own translated copy. */
  labels?: {
    /** In-flight (clock) glyph. */
    sending?: string;
    /** Acked-by-network (single check) glyph. */
    sent?: string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const { sending = 'Sending', sent: sentLabel = 'Sent' } = labels ?? {};
  if (delivery === 'failed') return null;
  const time = new Date(sentNs / 1e6).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const glyph = delivery === 'pending' ? 'clock-outline' : delivery === 'sent' ? 'check' : 'check-all';
  const glyphLabel = delivery === 'pending' ? sending : sentLabel;
  return (
    <View style={styles.row}>
      <Text style={[styles.time, onAccent && styles.timeOnAccent]}>{time}</Text>
      {fromMe ? (
        <Icon
          name={glyph}
          size={13}
          color={onAccent ? theme.colors.onAccentMuted : theme.colors.textMuted}
          accessibilityLabel={glyphLabel}
        />
      ) : null}
    </View>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: t.spacing.xs,
    marginTop: 2,
  },
  time: { fontSize: 10, color: t.colors.textMuted, fontVariant: ['tabular-nums'] },
  timeOnAccent: { color: t.colors.onAccentMuted },
  });
}
