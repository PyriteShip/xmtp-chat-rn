import React from 'react';
import { render } from '@testing-library/react-native';
import { BubbleMeta } from './BubbleMeta';

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
});
