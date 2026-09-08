/**
 * Ambient module declarations for RN dependencies that ship no types and have
 * no `@types/*` package. A host app typically carries its own copy of this
 * shim for its own imports; only the subpath this package actually imports
 * needs a declaration here.
 */
declare module 'react-native-vector-icons/MaterialCommunityIcons';

/**
 * The Web Crypto CSPRNG, used to generate the local database encryption key.
 * React Native has no `crypto` global of its own and RN's TypeScript config
 * deliberately omits the DOM lib, so this declares the one member this package
 * calls. A host must polyfill it — `import 'react-native-get-random-values'`
 * before this package is used — or key generation throws at runtime.
 */
declare const crypto: {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
};
