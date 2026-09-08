import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ReactionPills } from './ReactionPills';

describe('ReactionPills', () => {
  test('renders nothing when no one has reacted — no empty row under the bubble', () => {
    const { toJSON } = render(<ReactionPills reactions={[]} align="left" onToggle={() => {}} />);
    expect(toJSON()).toBeNull();
  });

  test('a lone reactor shows the emoji with no tally', () => {
    const { getByText, queryByText } = render(
      <ReactionPills reactions={[{ emoji: '👍', count: 1, mine: false }]} align="left" onToggle={() => {}} />,
    );
    expect(getByText('👍')).toBeTruthy();
    expect(queryByText('1')).toBeNull();
  });

  test('a shared reaction shows the count', () => {
    const { getByText } = render(
      <ReactionPills reactions={[{ emoji: '👍', count: 3, mine: true }]} align="left" onToggle={() => {}} />,
    );
    expect(getByText('3')).toBeTruthy();
  });

  test('tapping a pill toggles that emoji', () => {
    const onToggle = jest.fn();
    const { getByText } = render(
      <ReactionPills
        reactions={[
          { emoji: '👍', count: 1, mine: false },
          { emoji: '❤️', count: 2, mine: true },
        ]}
        align="right"
        onToggle={onToggle}
      />,
    );
    fireEvent.press(getByText('❤️'));
    expect(onToggle).toHaveBeenCalledWith('❤️');
  });

  test('labels a pill you hold as a removal, and one you do not as an add', () => {
    const { getByLabelText } = render(
      <ReactionPills
        reactions={[
          { emoji: '👍', count: 1, mine: false },
          { emoji: '❤️', count: 2, mine: true },
        ]}
        align="left"
        onToggle={() => {}}
      />,
    );
    expect(getByLabelText('React with 👍')).toBeTruthy();
    expect(getByLabelText('Remove your ❤️ reaction')).toBeTruthy();
  });
});
