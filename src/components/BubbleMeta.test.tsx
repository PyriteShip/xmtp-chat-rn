import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { BubbleMeta } from './BubbleMeta';
import { configureChatTheme, __resetChatTheme } from '../theme';

const SENT_NS = 1_700_000_000_000 * 1e6;

const meta = (props: Partial<React.ComponentProps<typeof BubbleMeta>> = {}) =>
  render(
    <BubbleMeta sentNs={SENT_NS} fromMe onAccent={false} locale="en-US" {...props} />,
  );

describe('BubbleMeta delivery glyph', () => {
  test('a read message announces itself as read, not merely delivered', () => {
    const { getByLabelText } = meta({ delivery: 'read' });
    expect(getByLabelText('Read')).toBeTruthy();
  });

  test('a delivered message is distinguishable from a read one', () => {
    const { queryByLabelText } = meta({ delivery: undefined });
    expect(queryByLabelText('Read')).toBeNull();
    expect(queryByLabelText('Delivered')).toBeTruthy();
  });

  test('the host can translate the read label', () => {
    const { getByLabelText } = meta({ delivery: 'read', labels: { read: 'Gelesen' } });
    expect(getByLabelText('Gelesen')).toBeTruthy();
  });

  test("a counterparty's message carries no delivery glyph at all", () => {
    const { queryByLabelText } = meta({ fromMe: false, delivery: 'read' });
    expect(queryByLabelText('Read')).toBeNull();
  });

  test('a failed message renders nothing — the bubble says so louder', () => {
    const { toJSON } = meta({ delivery: 'failed' });
    expect(toJSON()).toBeNull();
  });

  test('an unpublished message shows the waiting clock with its own label', () => {
    const { getByLabelText, queryByLabelText } = meta({ delivery: 'unpublished' });
    expect(getByLabelText('Waiting to send')).toBeTruthy();
    expect(queryByLabelText('Sent')).toBeNull();
  });
});

describe('BubbleMeta inside an own bubble', () => {
  afterEach(() => __resetChatTheme());

  // A host whose own bubbles are a pale tint rather than the accent draws the
  // timestamp in its own-bubble ink, not the on-accent ink meant for a dark fill.
  test('the timestamp reads in the own-bubble muted token', () => {
    configureChatTheme({ colors: { onAccentMuted: '#fbe6dd', onOwnBubbleMuted: '#6e625a' } });
    const { getByText } = meta({ onAccent: true });
    const time = getByText(/\d/);
    expect(StyleSheet.flatten(time.props.style).color).toBe('#6e625a');
  });
});
