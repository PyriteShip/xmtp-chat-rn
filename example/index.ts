// Must come first: viem's key generation calls crypto.getRandomValues, which
// React Native does not provide until this polyfill installs it.
import 'react-native-get-random-values';
// Hermes ships no global Buffer, and XMTP's JS layer reaches for one when it
// encodes the signature it hands to the native client — without this, client
// creation fails and the SDK reports it as "User rejected signature", which
// sends you looking at the wallet rather than at the runtime.
import { Buffer } from 'buffer';
if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}

import { registerRootComponent } from 'expo';

import App from './src/App';

registerRootComponent(App);
