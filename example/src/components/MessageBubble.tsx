/**
 * One row in the thread: the bubble body, its quote, its meta line, and — when
 * a send failed — the retry/discard notice.
 *
 * The package deliberately ships no bubble: what a message looks like is the
 * host's, and a card bubble is whatever the host's own content type deserves.
 * What it does ship is the furniture around one, which is what `QuotedMessage`,
 * `BubbleMeta` and `FailedNotice` are here.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BubbleMeta, FailedNotice, QuotedMessage } from 'xmtp-chat-rn';
import type { ExampleChatMessage } from '../messages';
import { colors, radius, spacing } from '../theme';

export function MessageBubble({
  message,
  quoted,
  onLongPress,
  onPressQuote,
  onRetry,
  onDiscard,
}: {
  message: ExampleChatMessage;
  quoted?: { author: string; preview: string };
  onLongPress?: () => void;
  onPressQuote?: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const mine = message.fromMe;
  const failed = message.kind === 'text' && message.delivery === 'failed';

  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
      <View style={styles.column}>
        <Pressable
          onLongPress={onLongPress}
          // A failed bubble is its own retry target, as well as offering the
          // explicit control below it.
          onPress={failed ? onRetry : undefined}
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            failed && styles.bubbleFailed,
          ]}
        >
          {quoted ? (
            <QuotedMessage
              author={quoted.author}
              preview={quoted.preview}
              tone={mine ? 'mine' : 'theirs'}
              onPress={onPressQuote}
            />
          ) : null}

          {message.kind === 'text' ? (
            <Text style={[styles.text, mine && !failed && styles.textMine]}>{message.text}</Text>
          ) : (
            // The custom content type gets its own shape rather than a text
            // bubble — the whole reason to register one.
            <View style={styles.nudge}>
              <Text style={styles.nudgeLabel}>NUDGE</Text>
              <Text style={[styles.text, mine && styles.textMine]}>{message.nudge.note}</Text>
            </View>
          )}

          <BubbleMeta
            sentNs={message.sentNs}
            fromMe={mine}
            delivery={message.kind === 'text' ? message.delivery : undefined}
            onAccent={mine && !failed}
            locale="en-US"
          />
        </Pressable>

        {failed ? <FailedNotice onRetry={onRetry} onDiscard={onDiscard} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: spacing.lg },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  column: { maxWidth: '80%' },
  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  bubbleMine: { backgroundColor: colors.accent, borderBottomRightRadius: radius.sm },
  bubbleTheirs: { backgroundColor: colors.fill, borderBottomLeftRadius: radius.sm },
  bubbleFailed: { backgroundColor: colors.dangerSoft },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  textMine: { color: colors.onAccent },
  nudge: { gap: 2 },
  nudgeLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
