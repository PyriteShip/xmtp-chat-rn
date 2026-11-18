// Pure-JS stand-in for `react-native-quick-base64` under Jest.
//
// The real module calls its native `QuickBase64` TurboModule
// (`TurboModuleRegistry.getEnforcing`), which does not exist in the Node test
// environment, and it ships as ESM under node_modules, which Jest's default
// transformIgnorePatterns leaves untransformed. This stub backs the same
// exports — `fromByteArray`, `toByteArray`, `byteLength`, `trimBase64Padding`,
// with 3.x's signatures — with Node's `Buffer`, which is byte-for-byte
// compatible for our use: base64 encode/decode of binary keys. The module
// installs no globals, and neither does this stub.
//
// Wired via jest.config.js moduleNameMapper, like the other stubs here.

function fromByteArray(uint8, urlSafe = false) {
  const b64 = Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString('base64');
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_') : b64;
}

function toByteArray(b64, removeLinebreaks = false) {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  if (removeLinebreaks) s = s.replace(/[\r\n]/g, '');
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function byteLength(b64) {
  return toByteArray(b64).length;
}

const trimBase64Padding = (str) => str.replace(/[.=]{1,2}$/, '');

module.exports = {
  fromByteArray,
  toByteArray,
  byteLength,
  trimBase64Padding,
};
