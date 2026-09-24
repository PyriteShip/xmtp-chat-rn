# Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.8] - 2026-09-23

### Fixed
- `sendTracked` no longer awaits a publish unbounded. On an SDK that offers
  both `prepareMessage` and `publishPreparedMessages` — stock
  `@xmtp/react-native-sdk` 5.7.0 does — it now prepares the message first (so
  it is stored under a known id), then races publishing it against
  `XmtpChatConfig.publishTimeoutMs` (default 15 000) instead of awaiting it
  unbounded. Previously, a publish that never resolved or rejected (an
  underlying transport that hung) left the local bubble `pending` forever,
  with no retry affordance — retry only ever showed for `failed` and stored
  `unpublished` bubbles. At the bound the publish is not cancelled (the SDK
  exposes no way to cancel it); the bubble becomes `unpublished` under the
  prepared id, the stream echo reconciles it whenever the publish does land,
  and `retryMessage` republishes the same id in the meantime.
- Attachments (`deliverAttachment`) and cards (`sendCard`) get the same fix
  for free — both already send through `sendTracked`.

### Changed (may need attention)
- On stock `@xmtp/react-native-sdk` 5.7.0, `sendTracked` now takes the
  prepare-then-publish path above for every send, rather than the `send`
  fallback it used before (5.7.0 has no `sendWithStatus`). One visible
  consequence: **a failed send's error now carries a `messageId`** on that
  SDK, where it never did before — `retryMessage` picks this up automatically
  (see README's "Delivery states"), but a host reading `err.messageId` itself
  should know it can now be set on stock 5.7.0.
- `XmtpChatConfig.publishTimeoutMs` (default 15 000): bounds the prepared
  publish above. Only takes effect on an SDK with `prepareMessage` +
  `publishPreparedMessages`; ignored otherwise.

## [0.0.7] - 2026-09-23

### Added
- `useConversation(address, context?, { readReceipts })`: a per-thread read
  receipt setting that replaces the host default for that thread. A receipt is a
  real send and every send marks the conversation allowed, so pass `false` for a
  thread shown before the user accepts it (a message request).
- Delivery state `unpublished`: the SDK stored the message but has not
  published it yet. `BubbleMeta` shows a clock labelled "Waiting to send" (new
  `labels.waiting`), and the stream echo replaces the bubble. It is set by an
  SDK whose `sendWithStatus` reports `queued`, and by history (see Changed).
- `sendTracked(dm, content, opts?)`: uses the SDK's `sendWithStatus` when the
  installed SDK has it (`queued` → `unpublished`), otherwise `send` with the
  same arguments as before. `useConversation`, reactions and `sendCard` send
  through it.
- `retryMessage` publishes an `unpublished` message at once, through the SDK's
  `publishPreparedMessages` (present on stock 5.7.0), under the same id. A
  host can offer this as "tap to send now".
- A failed send whose error reports the SDK's stored message id (a string
  `messageId`; stock 5.7.0 errors never carry one) keeps that id. The echo then
  reconciles by id, and a retry republishes the stored message through
  `publishPreparedMessages` instead of sending a second copy under a new id.
  `publishPreparedMessages` publishes every message the SDK holds for the
  conversation, not only the retried one.
- `isLocalId(id)`, exported: true for a local copy with no network id. Use
  `!isLocalId(message.id)` to decide whether a message can be quoted or
  reacted to.
- `XmtpChatConfig.push` (default on): `false` turns topic subscription and
  registration off.
- A development build (`__DEV__`) logs one `console.info` per session when
  `push` is on but `configureXmtpPush` was never called.

### Changed (may need attention)
- `MessageDelivery` gains `'unpublished'` (five members, was four). An
  exhaustive `switch` with a `never` check, or a `Record<MessageDelivery, …>`,
  needs a case for it.
- History: your own messages with SDK `deliveryStatus` `UNPUBLISHED` now
  render as `unpublished` (a "Waiting to send" clock) instead of as delivered,
  and `FAILED` ones as `failed` (with the retry bar) instead of as delivered.
  Retrying a `FAILED` one sends its content again, because the SDK will not
  publish it.
- `delivery` is no longer only on local copies: history `unpublished` and
  `failed` messages, and read messages, carry it and have network ids. A host
  that treated "has `delivery`" as "has no network id" should use `isLocalId`.
- An echo of your own message now also replaces a `failed` local copy with
  the same text, when the two were sent within 10 minutes of each other: a
  send can fail after the SDK stored the message, and it may still publish.
  Before, only `pending` and `sent` copies were matched.
- `BubbleMeta` has a new `labels.waiting` accessibility label with the English
  default "Waiting to send". A localized host should pass it.
- `registerXmtpPush` and `subscribeConversationTopics` do nothing, and log no
  warning, until `configureXmtpPush` has been called. Before, they reached the
  native layer and logged "Push server not registered" on every launch.
- `dropXmtpClient`, including the wallet switch inside
  `getOrCreateXmtpClient`, now clears the inbound handled-message ids from
  memory and from storage. A host that wipes storage on sign-out no longer gets
  the old identity's ids written back.
- `XmtpChatConfig.env` is typed as the installed SDK's `XMTPEnvironment` and
  passed through verbatim. On stock 5.7.0 that is the same
  `'local' | 'dev' | 'production'`.
- `reconcileSent` takes an optional fourth argument, the delivery state to
  record (`sent` by default, or `unpublished`).
- `setDelivery` takes an optional fourth argument, `newId`, which rekeys the
  message. If a message with `newId` is already listed, the local copy is
  dropped instead.

Unchanged on stock `@xmtp/react-native-sdk` 5.7.0: sends call `send(content)`
or `send(content, opts)` with the same arguments as 0.0.6, and a failed send
keeps its local id, so retry and discard behave as before.

### Fixed
- `discardFailed` is local only. It no longer calls the SDK's `deleteMessage`,
  which sends a deletion message to the peer and leaves the stored message
  queued, so the discarded message was delivered anyway. When the SDK had
  stored the message, a later publish may still deliver it and its echo brings
  the bubble back; retry is the reliable action for such a bubble.
- A retry whose echo arrives before the retry finishes no longer stamps a
  delivery state onto the confirmed message (which left it looking
  unconfirmed and not addressable).

## [0.0.6] - 2026-09-18

### Added
- `LocalAttachmentFile.byteLength` (optional). When a caller passes it — e.g.
  `expo-image-picker`'s `fileSize` — `uploadAttachment` rejects an oversized
  file with `AttachmentTooLargeError` BEFORE calling `client.encryptAttachment`,
  which is what makes `maxBytes` an actual memory guard rather than only the
  existing post-encryption backstop (which still runs when `byteLength` is
  absent).
- `clearAttachmentCache()`, exported from the package root. `dropXmtpClient`
  and `resetXmtpLocalState` now call it as part of teardown, so a file
  decrypted under the wallet that just signed out (or whose local state was
  just wiped) is not still reachable in memory after switching identity.
  Replaces the internal `__resetAttachmentCache` test seam.
- `MultiRemoteAttachmentCodec` (XMTP's several-files-in-one-message type) is
  now registered too, plus `MULTI_REMOTE_ATTACHMENT_TYPE_PREFIX` and
  `isMultiRemoteAttachment` in `attachmentContent.ts`. Previously unregistered,
  so it decoded to nothing and produced no bubble and no inbox row at all —
  the recipient saw nothing. Now treated exactly like an inline static
  attachment: `useConversation` yields a `kind: 'text'` bubble from the
  message's wire fallback (dropped when there is none), and `describeMessage`
  returns `{ kind: 'card', cardKind: 'multiRemoteAttachment', preview: null,
  fallback }`. Rendering the individual files remains out of scope.
- Attachments over XMTP's standard remote attachment content type.
  `configureXmtpChat({ attachments: { upload, download, maxBytes } })` supplies
  storage; the package encrypts before upload and decrypts after download.
  `useConversation` gains `sendAttachment` (optimistic, retryable) and an
  `attachment` message kind; `useAttachment` loads one for rendering;
  `describeMessage` returns `{ kind: 'attachment', filename, fromMe }`.
- `createPresignedPutUploader` (S3, R2, GCS, MinIO) and `createIpfsUploader`
  (pinning service + https gateway), plus `uploadAttachment`, `openAttachment`,
  `AttachmentTooLargeError`, `AttachmentsNotConfiguredError` and
  `DEFAULT_ATTACHMENT_MAX_BYTES`.
- The remote and static attachment codecs are registered on every client, so
  other clients' attachments decode even with `attachments` unset. An inline
  static attachment (bytes on the wire, no upload) renders as its text
  fallback rather than the image or file itself.
- `createProxyUploader`, for a host whose server holds the storage binding
  itself (e.g. a Cloudflare Worker with an R2 binding) rather than presigning
  a URL, so no storage credential exists on the device at all. It posts the
  ciphertext to your endpoint and reads the public URL back from the
  response, sending the digest and byte length as headers
  (`x-attachment-digest`, `x-attachment-bytes`) so your server can
  authorize/key the object without buffering the body first.
- `timeoutMs` on `createPresignedPutUploader` and `createProxyUploader`
  (default `DEFAULT_UPLOAD_TIMEOUT_MS`, 60s; `0` or negative disables it), so
  a hung upload fails the bubble with a named error instead of leaving it
  pending forever.

### Changed
- `attachment` is now a reserved `ChatMessage` kind. A card registered with
  `kind: 'attachment'` collides with it and must be renamed.
- `MessageDescription` has a new `attachment` member; an exhaustive `switch` over
  it needs the new case.
- An inbound remote attachment from another client appears in `messages` as
  `kind: 'attachment'`, and describes as a previewable `attachment`
  (`describeMessage`/`isPreviewable`), only once this app has `attachments`
  configured — a host that never opted in can't render or open one, so it
  degrades the same way a static attachment always has: the thread shows the
  codec's fallback text as an ordinary `kind: 'text'` bubble, and the inbox
  row describes it as `{ kind: 'card', cardKind: 'remoteAttachment', preview:
  null, fallback }`. This means an existing host upgrades to this version
  without a runtime break, at the cost of an exhaustive `switch` over
  `ChatMessage` or `MessageDescription` still needing the new cases to
  typecheck: `kind: 'attachment'` on both, and `cardKind: 'remoteAttachment'`
  wherever card kinds are enumerated.
- An inline static attachment (sent by another client — this package only
  ever sends the remote variant) describes with `cardKind: 'staticAttachment'`
  (previously `'attachment'`, which collided with the first-class message
  kind above).

### Fixed
- `useAttachment` now keys its reload effect and recycled-cell guard on
  `contentDigest` + `secret`, the same composite key the package cache
  (`attachments.ts`) uses, instead of `contentDigest` alone. Two contents
  that share a digest but carry different secrets are now treated as
  different files, rather than the hook silently reusing (or racing) one
  file's result for the other's content.
- Corrected three inaccuracies found while working on the above: the
  decrypted-attachment cache's key comment claimed two contents share a
  `contentDigest` because "the plaintext hashes the same" — wrong, the
  digest is over the ciphertext and each file gets a fresh random secret, so
  identical plaintext hashes differently; the real case the composite key
  guards against is a sender-crafted message reusing another file's digest
  with a different secret. `deliverAttachment`'s doc comment mentioned only
  the oversized-file case; it also discards and rethrows
  `AttachmentsNotConfiguredError`. And the README's attachment bubble example
  rendered the filename from the decrypted `status.file` rather than
  `message.attachment.filename` — the decrypted file carries the picker's
  temp name, since the native SDK writes it inside the ciphertext.
- `createProxyUploader`'s upload timeout no longer stops at the response
  headers. `fetchWithTimeout` used to clear its timer as soon as `fetch()`
  resolved — which happens once headers arrive — before the default
  `publicUrl` extraction (`(await res.json()).url`) read the body. A proxy
  that returned 200 and then stalled the body hung `uploadAttachment`
  forever, exactly the failure the timeout exists to prevent. The timer now
  stays live until the body read itself settles.
- Attachment-cache teardown (`dropXmtpClient` / `resetXmtpLocalState`) no
  longer reaches `clearAttachmentCache` through a lazy `require` wrapped in a
  blanket try/catch — a rename or typo there would pass `tsc` and silently
  leave the cache populated after sign-out, a privacy-relevant failure
  nothing could catch, and the `require` doesn't exist in the ESM build at
  all. `openCacheKey` and `clearAttachmentCache` now live in a new leaf
  module, `attachmentCache.ts`, that `attachments.ts` and `client.ts` both
  import statically with no cycle between them.
- A caller-supplied header to `createProxyUploader` that differs only in
  case from a fixed one (e.g. `content-type` vs `Content-Type`) no longer
  produces a duplicate that `Headers` combines instead of one overriding the
  other — caller keys are now lowercased before merging.
- `uploadAttachment`'s pre-encryption size check now uses `Number.isFinite`
  rather than `!== undefined`, so a caller-supplied `byteLength` that is
  `NaN`, `Infinity`, or otherwise not a real number falls through to the
  post-encryption check instead of silently being treated as "not too large".
- The README's `createProxyUploader` Worker example now verifies the digest
  header against the received bytes before using it as the R2 key, instead
  of trusting it as sent — the previous snippet let any caller overwrite
  another user's object by claiming its key. Also documented explicitly what
  `x-attachment-digest` (ciphertext SHA-256, authoritative once verified) and
  `x-attachment-bytes` (plaintext size, approximate) each describe, so a
  server doesn't compare the byte header to `Content-Length` or size a
  storage quota from it.

## [0.0.5] - 2026-09-16
### Fixed
- Client creation is bounded by a timeout. Creation is single-flighted per
  address, so a `Client.create` that hung (an unanswered signature, a stalled
  network call) was handed to every later caller and `retryXmtpClient` rejoined
  it — "retrying" never ended. After `clientCreateTimeoutMs` (default 60 000,
  `null` disables) the attempt rejects with `XmtpClientCreateTimeoutError`,
  status turns `failed`, and the next call starts a fresh attempt. An abandoned
  attempt that settles late never replaces or re-announces a client from a
  newer attempt; with no newer attempt, its client is adopted and
  `onXmtpClientReady` fires once.

### Added
- `clientCreateTimeoutMs` on `configureXmtpChat`, plus
  `XmtpClientCreateTimeoutError`, `isXmtpClientCreateTimeoutError` and
  `DEFAULT_CLIENT_CREATE_TIMEOUT_MS`.

## [0.0.2] - 2026-09-12
### Fixed
- Sign-in no longer revokes the wallet's other installations. With
  `devInstallationPrune` on, every successful `Client.create` called
  `revokeAllOtherInstallations`, which revoked the same wallet's installations
  on other physical devices — a debug Android sign-in revoked the iPhone
  build. A revoked installation keeps working locally and appears to send,
  but every recipient drops its messages: silent, total loss. Sign-in now
  never revokes anything, whatever the flag says.
- The at-cap recovery (`already registered 10/10 installations` → revoke →
  retry create once) revokes only the oldest installation(s) needed to free
  one slot, sorted by `createdAt` with unknown ages last, instead of every
  installation on the inbox.

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

[Unreleased]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.7...HEAD
[0.0.7]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.2...v0.0.5
[0.0.2]: https://github.com/PyriteShip/xmtp-chat-rn/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/PyriteShip/xmtp-chat-rn/releases/tag/v0.0.1
