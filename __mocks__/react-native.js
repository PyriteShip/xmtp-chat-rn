// Stub for the `react-native` import surface used by src/lib/ and
// src/components/ tests. lib/ tests only use Platform; component tests
// rendered via react-test-renderer need the host-component primitives
// (View, Text, etc.) as well.
const React = require('react');

// Minimal host-component stubs for react-test-renderer.
// react-test-renderer doesn't call into native; it just needs valid React
// element constructors. Plain function components work fine.
function makeView(displayName) {
  function Comp({ children, ...rest }) {
    return React.createElement(displayName, rest, children);
  }
  Comp.displayName = displayName;
  return Comp;
}

const Easing = {
  bezier: () => () => 0,
  ease: () => 0,
  linear: (t) => t,
  in: (f) => f,
  out: (f) => f,
  inOut: (f) => f,
};

// Animated stub — enough for components (SwipeToReply) that drive a simple
// translate/scale animation: Value holds a number, timing().start() is a no-op.
const Animated = {
  View: makeView('Animated.View'),
  Text: makeView('Animated.Text'),
  Value: function AnimatedValue(v) {
    this._value = v;
    this.setValue = (nv) => { this._value = nv; };
    this.interpolate = () => this;
  },
  timing: () => ({ start: (cb) => { if (cb) cb({ finished: true }); } }),
  // loop/sequence as inert handles — nothing here drives a real animation.
  sequence: () => ({ start: () => {}, stop: () => {} }),
  loop: () => ({ start: () => {}, stop: () => {} }),
};

module.exports = {
  Platform: { OS: 'android', select: (obj) => obj.android ?? obj.default },
  Easing,
  Animated,
  StyleSheet: {
    create: (styles) => styles,
    flatten: (style) => (Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style ?? {}),
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    hairlineWidth: 1,
  },
  View: makeView('View'),
  Text: makeView('Text'),
  TextInput: makeView('TextInput'),
  TouchableOpacity: makeView('TouchableOpacity'),
  Pressable: makeView('Pressable'),
  Switch: makeView('Switch'),
  ScrollView: makeView('ScrollView'),
  KeyboardAvoidingView: makeView('KeyboardAvoidingView'),
  Image: makeView('Image'),
  Modal: makeView('Modal'),
  ActivityIndicator: makeView('ActivityIndicator'),
  Vibration: { vibrate: () => {} },
  Linking: {
    openSettings: () => Promise.resolve(),
    openURL: () => Promise.resolve(),
    canOpenURL: () => Promise.resolve(true),
  },
};
