// Must come first: viem's key generation calls crypto.getRandomValues, which
// React Native does not provide until this polyfill installs it.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';

import App from './src/App';

registerRootComponent(App);
