// The platform hooks are iOS App Group plumbing. Absent, the package must
// behave exactly like today's Android path — a null db directory and a silent
// no-op mirror — rather than crashing on an undefined call.
import { configureXmtpChat, xmtpConfig } from './configure';

test('an absent platform object behaves like the Android path', () => {
  configureXmtpChat({ env: 'dev', enabled: true, cards: [] });
  const { platform } = xmtpConfig();
  expect(platform?.dbDirectory?.() ?? null).toBeNull();
  expect(() => platform?.setSharedItem?.('k', 'v')).not.toThrow();
  expect(() => platform?.migrateDbIfNeeded?.()).not.toThrow();
});

test('reading config before configuring is a loud failure, not a silent default', () => {
  jest.resetModules();
  const fresh = require('./configure');
  expect(() => fresh.xmtpConfig()).toThrow(/configureXmtpChat/);
});
