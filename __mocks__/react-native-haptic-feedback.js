// Stub for `react-native-haptic-feedback` under Jest.
//
// The real module's index pulls a codegen TurboModule spec
// (NativeHapticFeedback) that calls TurboModuleRegistry.getEnforcing at import
// time, which throws in the Node test environment. cardApdu.ts imports the
// default export and calls `.trigger()` for tap feedback — irrelevant to the
// pure-logic tests, so a no-op stub is enough.
//
// Mirrors the existing __mocks__/react-native-nfc-manager.js pattern, wired via
// jest.config.js moduleNameMapper.

const stub = {
  trigger: () => {},
  HapticFeedbackTypes: {},
};

module.exports = stub;
module.exports.default = stub;
