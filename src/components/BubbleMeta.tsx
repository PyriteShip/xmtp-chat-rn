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
 * Glyphs track the states the send pipeline produces (see deliveryState.ts): a
 * clock while in flight, one check on the network's ack, two once the stream
 * echoes the authoritative copy back, and those two in the accent colour once
 * the counterparty's read receipt arrives. `failed` has its own, louder
 * treatment on the bubble ("Not delivered · Tap to retry") and is not shown
 * here.
 *
 * Delivered and read share the double-check glyph and differ only in colour, so
 * each state carries its own accessibility label — colour alone is not a
 * distinction a screen reader can convey.
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
    /** Confirmed by the stream echo (double check) glyph. */
    delivered?: string;
    /** Read by the counterparty (accent double check) glyph. */
    read?: string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const {
    sending = 'Sending',
    sent: sentLabel = 'Sent',
    delivered = 'Delivered',
    read = 'Read',
  } = labels ?? {};
  if (delivery === 'failed') return null;
  const time = new Date(sentNs / 1e6).toLocaleTimeString(locale, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const glyph = delivery === 'pending' ? 'clock-outline' : delivery === 'sent' ? 'check' : 'check-all';
  const glyphLabel =
    delivery === 'pending' ? sending
    : delivery === 'sent' ? sentLabel
    : delivery === 'read' ? read
    : delivered;
  // Read is the one state that earns a colour of its own. Inside an accent
  // bubble the accent is the background, so it borrows the full-strength
  // on-accent ink instead — the same "brighter than the other glyphs" signal.
  const glyphColor =
    delivery === 'read'
      ? (onAccent ? theme.colors.onAccent : theme.colors.accent)
      : (onAccent ? theme.colors.onAccentMuted : theme.colors.textMuted);
  return (
    <View style={styles.row}>
      <Text style={[styles.time, onAccent && styles.timeOnAccent]}>{time}</Text>
      {fromMe ? (
        <Icon
          name={glyph}
          size={13}
          color={glyphColor}
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
