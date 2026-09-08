// Pure-JS stand-in for `react-native-quick-base64` under Jest.
//
// The real module is a thin wrapper over native base64 functions installed on
// `global` by a JSI native module at app startup (`global.base64FromArrayBuffer`
// / `base64ToArrayBuffer`). Those globals don't exist in the Node test
// environment, and the module's top-level `import { NativeModules } from
// 'react-native'` also can't be transformed (it's ignored by
// transformIgnorePatterns). We back the same surface with Node's `Buffer`,
// which is byte-for-byte compatible for our use (ipfsPinner's base64 helpers).
//
// Mirrors the existing __mocks__/{react-native,react-native-nfc-manager,
// react-native-mmkv}.js pattern, wired via jest.config.js moduleNameMapper.

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

function btoa(data) {
  return Buffer.from(data, 'binary').toString('base64');
}

function atob(b64) {
  return Buffer.from(b64, 'base64').toString('binary');
}

function shim() {
  global.btoa = btoa;
  global.atob = atob;
}

const getNative = () => ({
  base64FromArrayBuffer: (buf, urlSafe) => fromByteArray(new Uint8Array(buf), urlSafe),
  base64ToArrayBuffer: (b64, removeLinebreaks) => toByteArray(b64, removeLinebreaks).buffer,
});

const trimBase64Padding = (str) => str.replace(/[.=]{1,2}$/, '');

module.exports = {
  fromByteArray,
  toByteArray,
  byteLength,
  btoa,
  atob,
  shim,
  getNative,
  trimBase64Padding,
};
