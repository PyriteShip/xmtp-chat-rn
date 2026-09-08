import React from 'react';
import { Modal } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { MessageActionsSheet } from './MessageActionsSheet';
import { QUICK_REACTIONS } from '../chatReactions';

const target = {
  id: 'msg-1',
  preview: 'Perfect. It’s on the calendar',
  myEmoji: null as string | null,
  copyText: 'Perfect. It’s on the calendar',
};

const noop = () => {};

describe('MessageActionsSheet', () => {
  test('offers every quick reaction plus Reply and Copy', () => {
    const { getByText } = render(
      <MessageActionsSheet target={target} onClose={noop} onReact={noop} onReply={noop} onCopy={noop} />,
    );
    for (const emoji of QUICK_REACTIONS) expect(getByText(emoji)).toBeTruthy();
    expect(getByText('Reply')).toBeTruthy();
    expect(getByText('Copy')).toBeTruthy();
  });

  test('echoes the message so the target of the actions is unambiguous', () => {
    const { getByText } = render(
      <MessageActionsSheet target={target} onClose={noop} onReact={noop} onReply={noop} onCopy={noop} />,
    );
    expect(getByText('Perfect. It’s on the calendar')).toBeTruthy();
  });

  test('hides Copy for a card, which has no body worth putting on the clipboard', () => {
    const { queryByText, getByText } = render(
      <MessageActionsSheet
        target={{ ...target, copyText: null, preview: 'Offer · Concrete saw' }}
        onClose={noop}
        onReact={noop}
        onReply={noop}
        onCopy={noop}
      />,
    );
    expect(queryByText('Copy')).toBeNull();
    expect(getByText('Reply')).toBeTruthy();
  });

  test('the quick-reaction set is configurable, defaulting to Signal\'s six', () => {
    const { getByText, queryByText } = render(
      <MessageActionsSheet
        target={target}
        quickReactions={['🔧', '🪚']}
        onClose={noop}
        onReact={noop}
        onReply={noop}
        onCopy={noop}
      />,
    );
    expect(getByText('🔧')).toBeTruthy();
    expect(queryByText(QUICK_REACTIONS[0])).toBeNull();
  });

  test('tapping an emoji reports it', () => {
    const onReact = jest.fn();
    const { getByText } = render(
      <MessageActionsSheet target={target} onClose={noop} onReact={onReact} onReply={noop} onCopy={noop} />,
    );
    fireEvent.press(getByText('😂'));
    expect(onReact).toHaveBeenCalledWith('😂');
  });

  test('the emoji you already hold reads as a removal, so a second tap is legible', () => {
    const { getByLabelText } = render(
      <MessageActionsSheet
        target={{ ...target, myEmoji: '👍' }}
        onClose={noop}
        onReact={noop}
        onReply={noop}
        onCopy={noop}
      />,
    );
    expect(getByLabelText('Remove your 👍 reaction')).toBeTruthy();
    expect(getByLabelText('React with ❤️')).toBeTruthy();
  });

  // The Modal's own `visible` is what gates the sheet — the RN mock renders
  // modal children unconditionally, so assert the prop rather than the content.
  test('is closed when there is no target and open when there is', () => {
    const closed = render(
      <MessageActionsSheet target={null} onClose={noop} onReact={noop} onReply={noop} onCopy={noop} />,
    );
    expect(closed.UNSAFE_getByType(Modal).props.visible).toBe(false);

    const open = render(
      <MessageActionsSheet target={target} onClose={noop} onReact={noop} onReply={noop} onCopy={noop} />,
    );
    expect(open.UNSAFE_getByType(Modal).props.visible).toBe(true);
  });
});
