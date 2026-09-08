// A failed send is the delivery state that needs the reader to act, so both
// affordances have to be reachable and distinct: retry alone strands a message
// that will never send, discard alone loses text the sender may still want.
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { FailedNotice } from './FailedNotice';

test('the notice retries and never discards on the same press', () => {
  const onRetry = jest.fn();
  const onDiscard = jest.fn();
  const { getByText } = render(<FailedNotice onRetry={onRetry} onDiscard={onDiscard} />);

  fireEvent.press(getByText('Not delivered · Tap to retry'));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onDiscard).not.toHaveBeenCalled();
});

test('the discard control discards and never retries', () => {
  const onRetry = jest.fn();
  const onDiscard = jest.fn();
  const { getByLabelText } = render(<FailedNotice onRetry={onRetry} onDiscard={onDiscard} />);

  fireEvent.press(getByLabelText('Discard message'));
  expect(onDiscard).toHaveBeenCalledTimes(1);
  expect(onRetry).not.toHaveBeenCalled();
});

test('a host can supply its own copy for both affordances', () => {
  const { getByText, getByLabelText } = render(
    <FailedNotice
      onRetry={jest.fn()}
      onDiscard={jest.fn()}
      labels={{ notDelivered: 'Не доставлено', discard: 'Відхилити' }}
    />,
  );
  expect(getByText('Не доставлено')).toBeTruthy();
  expect(getByLabelText('Відхилити')).toBeTruthy();
});
