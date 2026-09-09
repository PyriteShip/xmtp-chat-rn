# Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- `example/` — a runnable Expo demo app: an inbox and a thread, with replies,
  reactions, delivery state, a themed component set and one custom content
  type. It installs this package from npm the way a consuming app does, so it
  exercises the published `exports` map and `lib/` build rather than the source
  beside it; `npm run use-local` repoints it at the working tree. CI typechecks
  and Metro-bundles it against the current commit's build.

### Documented
- The global `Buffer` polyfill a host must install: the XMTP SDK's JS layer
  reads one while encoding the signature it passes to the native client, and
  Hermes provides none. Without it, client creation fails and the SDK reports
  it as `User rejected signature`.
- The Expo SDK ceiling. `@xmtp/react-native-sdk@5.7.0` does not compile against
  Expo 57: `XMTPModule.definition()` exceeds the JVM's 64 KB per-method limit
  under `expo-modules-core` 57. Upstream, unfixable from a host, and tracked at
  xmtp/xmtp-react-native#777.

## [0.0.1] - 2026-09-08
### Added
- Initial release, extracted from a production React Native app where this code
  ships today. This is a **pre-verification extraction**: the package has not
  been exercised at runtime on a device as an installed dependency, so `v0.1.0`
  is reserved to mark the device-verified cut. It compiles into an iOS app — a
  consuming app's CI resolves it from git, runs `pod install` and completes an
  unsigned `xcodebuild` — but compiling is not running.
- Client lifecycle — `getOrCreateXmtpClient` (idempotent per address, tearing
  down a prior address so two sign-ins cannot burn two of XMTP's ten per-inbox
  installation slots), `dropXmtpClient`, `resetXmtpLocalState` for a wedged MLS
  database, plus `subscribeXmtpClient` / `getActiveXmtpClient` for observers.
- `useConversation` — a 1:1 thread with optimistic send, delivery state,
  replies and reactions, and an optional host-supplied context card posted at
  the top of the thread.
- `useConversations` / `useUnreadCount` — inbox listing and unread tally, both
  fed by one global inbound stream (`startInboundMessages`) rather than a
  second subscription.
- Card registry — `CardType` descriptors let a host declare its own content
  types once (codec, wire recognition, shape check, bubble kind, optional
  preview and notification hooks). `ChatMessage<Cards, Extra>` derives the
  bubble union from the registry, so a payload-key typo fails typecheck at the
  reading site.
- `describeMessage` — a structured `MessageDescription` for inbox rows and
  notification bodies. The package emits no user-facing copy; the host renders
  it. `isPreviewable` is the emptiness test unread calculations use.
- Background push — `registerXmtpPush` behind `isPushServerReachable`, a
  mandatory probe: the native `XMTPPush` call runs on the shared XMTP runtime,
  so against a port with no route it hangs and wedges the whole client.
- Consent — `blockContact` maps to XMTP consent `denied`.
- Injectable theme — `configureChatTheme` merges host tokens over brand-free
  defaults, scoped to what these components draw (twelve colours, five
  spacings, three radii, two text styles, one shadow) rather than a whole
  design system.
- Seven chat primitives: `BubbleMeta`, `FailedNotice`, `MessageActionsSheet`,
  `QuotedMessage`, `ReactionPills`, `ScrollToLatest`, `SwipeToReply`. Labels
  are props with English defaults.
- Platform hooks — optional `dbDirectory` / `setSharedItem` / `migrateDbIfNeeded`
  for an iOS App Group, so a notification extension can open the same MLS
  database.
- Builds via `react-native-builder-bob` to CommonJS, ESM and declarations;
  typechecks and tests standalone (16 suites, 116 tests) with no resolver
  overrides in the consuming app.

### Not included
- **Groups.** This is 1:1 only by design — the client, hooks, inbox listing and
  notification stream all assume one counterparty per conversation.
- **Attachments.** XMTP has a remote-attachment content type and the React
  Native SDK supports it; this package does not wire it up.

[Unreleased]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/PyriteShip/xmtp-chat-rn/releases/tag/v0.0.1
