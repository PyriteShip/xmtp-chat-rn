// Stub for `react-native-haptic-feedback` under Jest.
//
// The real module's index pulls a codegen TurboModule spec
// (NativeHapticFeedback) that calls TurboModuleRegistry.getEnforcing at import
// time, which throws in the Node test environment. SwipeToReply imports the
// default export and calls `.trigger()` for swipe feedback — irrelevant to the
// pure-logic tests, so a no-op stub is enough.
//
// Wired via jest.config.js moduleNameMapper, like the other stubs here.

const stub = {
  trigger: () => {},
  HapticFeedbackTypes: {},
};

module.exports = stub;
module.exports.default = stub;
