/**
 * Height of the on-screen keyboard, or 0 when it is closed.
 *
 * React Native's own `KeyboardAvoidingView` is not enough here. On Android it
 * relies on the window being resized by `windowSoftInputMode="adjustResize"`,
 * and from API 35 the system ignores that — an app under edge-to-edge is
 * expected to read the IME inset itself. The `Keyboard` events still report
 * the height correctly, so a listener and a padding value do the whole job
 * without pulling a native module into the example.
 */

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    // iOS emits `will` events ahead of the animation, which lets the composer
    // travel with the keyboard instead of snapping after it. Android only ever
    // emits the `did` pair.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
