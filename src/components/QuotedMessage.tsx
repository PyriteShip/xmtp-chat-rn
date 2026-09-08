import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { chatTheme, type ChatTheme } from '../theme';

/** Where the quote is drawn — it has to read against three backgrounds. */
export type QuoteTone =
  /** Inside one of your own accent-coloured bubbles. */
  | 'mine'
  /** Inside one of theirs (fill). */
  | 'theirs'
  /** In the reply bar above the composer (surface). */
  | 'composer';

/**
 * Signal's quote block: an accent rail, the author on one line, the message it
 * points at on the next, clipped to a single line.
 *
 * Used both inside a reply bubble and in the composer's reply bar, so a quote
 * looks identical whether you are about to send it or reading it back. The
 * `author`/`preview` split is the caller's — `quotePreview` in lib/chatQuote
 * reduces any thread row to the one line shown here.
 */
export function QuotedMessage({
  author,
  preview,
  tone,
  onPress,
  onDismiss,
  labels,
}: {
  /** Display name of whoever wrote the quoted message ("You" for yourself). */
  author: string;
  /** The quoted message reduced to one line. */
  preview: string;
  tone: QuoteTone;
  /** Tapping the quote jumps to the message it points at. */
  onPress?: () => void;
  /** Renders the ✕ that clears a pending reply (composer bar only). */
  onDismiss?: () => void;
  /** Accessibility labels. English defaults; the host supplies its own translated copy. */
  labels?: {
    /** The ✕ that clears a pending reply. */
    cancel?: string;
    /** Tapping the quote to jump to the message it points at. */
    jump?: string;
  };
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const { cancel = 'Cancel reply', jump = 'Go to the message being replied to' } = labels ?? {};
  const onAccent = tone === 'mine';
  const body = (
    <View style={[styles.row, onAccent ? styles.rowOnAccent : styles.rowOnSurface]}>
      <View style={[styles.rail, onAccent ? styles.railOnAccent : styles.railOnSurface]} />
      <View style={styles.text}>
        <Text style={[styles.author, onAccent && styles.authorOnAccent]} numberOfLines={1}>
          {author}
        </Text>
        <Text style={[styles.preview, onAccent && styles.previewOnAccent]} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      {onDismiss ? (
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel={cancel}
        >
          <Icon name="close" size={18} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={jump}
    >
      {body}
    </TouchableOpacity>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    borderRadius: t.radius.sm,
    paddingVertical: 5,
    paddingRight: t.spacing.sm,
    overflow: 'hidden',
  },
  // Inside an accent bubble the quote is a wash over the accent itself;
  // on light backgrounds it is the neutral fill.
  rowOnAccent: { backgroundColor: t.colors.onAccentFill },
  rowOnSurface: { backgroundColor: t.colors.fill },
  rail: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  railOnAccent: { backgroundColor: t.colors.onAccent },
  railOnSurface: { backgroundColor: t.colors.accent },
  text: { flex: 1, gap: 1 },
  author: { fontSize: 12, fontWeight: '700', color: t.colors.accent },
  authorOnAccent: { color: t.colors.onAccent },
  preview: { fontSize: 12, color: t.colors.textSoft, lineHeight: 16 },
  previewOnAccent: { color: t.colors.onAccentMuted },
  });
}
