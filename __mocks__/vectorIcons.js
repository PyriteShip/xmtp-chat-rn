// Jest stub for react-native-vector-icons icon sets (MaterialCommunityIcons,
// etc.). The real package is ESM and pulls a native font module, neither of
// which jest transforms. This renders the requested glyph `name` as Text so
// tests can assert which icon was requested without the native dependency.
const React = require('react');
const { Text } = require('react-native');

const Icon = ({ name, size, color, ...rest }) => React.createElement(Text, rest, name);

module.exports = Icon;
module.exports.default = Icon;
