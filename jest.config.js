/**
 * Jest for a React Native library, without the RN preset.
 *
 * The preset's setup file imports `@react-native/js-polyfills/error-guard.js`,
 * which is Flow and crashes Babel parsing here. Nothing in this package needs
 * the RN runtime — the components render through react-test-renderer, which
 * only needs valid element constructors — so a vanilla babel-jest pipeline plus
 * stubs for the native modules is both faster and quieter.
 *
 * Every entry in `moduleNameMapper` is a native module: a TurboModule, a Nitro
 * module, or the XMTP SDK, none of which load under Node. The stubs implement
 * only the surface this package calls.
 */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': [
      'babel-jest',
      {
        // preset-typescript strips annotations; modules-commonjs rewrites
        // import/export so the ESM sources load through Node's require.
        // @babel/preset-env is deliberately absent — Node 18+ already parses
        // everything these sources use.
        presets: [['@babel/preset-typescript'], ['@babel/preset-react', { runtime: 'automatic' }]],
        // dynamic-import-node rewrites the lazy `await import(...)` in
        // sendCard/xmtpPush to require(), so they run — and can be mocked —
        // under Jest's CommonJS VM. Without it Node demands
        // --experimental-vm-modules.
        plugins: ['@babel/plugin-transform-modules-commonjs', 'babel-plugin-dynamic-import-node'],
      },
    ],
  },
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.js',
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.js',
    '^react-native-quick-base64$': '<rootDir>/__mocks__/react-native-quick-base64.js',
    '^react-native-haptic-feedback$': '<rootDir>/__mocks__/react-native-haptic-feedback.js',
    '^react-native-vector-icons/.*$': '<rootDir>/__mocks__/vectorIcons.js',
    '^@xmtp/react-native-sdk$': '<rootDir>/__mocks__/@xmtp/react-native-sdk.js',
  },
};
