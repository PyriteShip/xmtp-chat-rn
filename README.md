# xmtp-chat-rn

[![npm](https://img.shields.io/npm/v/xmtp-chat-rn)](https://www.npmjs.com/package/xmtp-chat-rn)
[![CI](https://github.com/PyriteShip/xmtp-chat-rn/actions/workflows/ci.yml/badge.svg)](https://github.com/PyriteShip/xmtp-chat-rn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/xmtp-chat-rn)](./LICENSE)

Wallet-native 1:1 messaging for React Native, built on [XMTP](https://xmtp.org):
client lifecycle, hooks, and chat primitives.

If your app already has wallets, this gives you chat without a messaging vendor.
Identity is the wallet — no user directory to sync, no separate auth. Messages are
end-to-end encrypted with MLS, so nothing in the middle can read them, including
you. And because XMTP is a protocol rather than a product, your users are
reachable from other XMTP clients, not only from your app.

Whether that last point is a feature or a surprise depends on what you are
building. It is the honest difference between this and a hosted chat API, and
worth deciding about before adopting either.

## Scope

**Direct messages between two wallets. Groups are not supported** — the client,
the hooks, the inbox listing and the notification stream all assume exactly one
counterparty per conversation, and adding groups means changing all four rather
than adding a surface.

What is here: client lifecycle (creation, per-address idempotence, installation-cap
recovery, wedged-MLS reset), the conversation and unread hooks, optimistic send
with delivery state, replies, reactions and read receipts, consent-based blocking, background push
registration, a registry for a host's own content types, and seven chat components
(bubble meta, quoted message, reaction pills, swipe-to-reply, scroll-to-latest,
message actions, failed-send notice).

What is not: a chat screen. The components are primitives a host composes; the
screen shell, the bubble bodies and any product-specific banners stay in the host.

### Compared to a hosted chat API

Stream and Sendbird will do things this does not. They ship groups, typing
indicators, moderation, search, threads and attachments, plus a
dashboard and a support contract. If you need those, buy them — this is not a
drop-in replacement and pretending otherwise wastes your time.

What they cannot do is let someone message your user from a different app, or
avoid holding your users' messages, or bill nothing per monthly active user.

Two costs this does not remove. **Attachments are unimplemented here** — XMTP has
a remote-attachment content type and the React Native SDK supports it, so this is
a gap in this package rather than in the protocol. And **background push needs a
server**: a hosted API bundles it, whereas XMTP push means running something that
listens and forwards. "No per-MAU vendor" is the accurate claim, not "no
infrastructure".

## Getting started

Three steps: configure once at startup, render a thread from the hook, and give
the package your content types if you have any.

### 1. Configure

Call these once at module scope in your entry file, before anything renders.
`xmtpConfig()` throws if a hook reaches it unconfigured — an unconfigured client
would register against the wrong XMTP network and build an inbox nobody can
reach, so this fails loudly rather than silently.

```ts
import { configureXmtpChat, configureChatTheme, configureXmtpPush } from 'xmtp-chat-rn';

configureXmtpChat({
  env: 'production',        // 'dev' | 'production' | 'local'
  enabled: true,            // your feature flag; false disables the unread count
  cards: MY_CARD_TYPES,     // [] if you have no custom content types
});

configureChatTheme({ colors: { accent: '#3b6ea5' } });   // optional
configureXmtpPush({ serverUrl, probeUrl });              // optional, see Push
```

### 2. Create a client

You build the XMTP `Signer`; the package holds no wallet dependencies. `address`
travels alongside it because per-address idempotence is checked before any
`await`, and `getIdentifier()` is async.

```ts
import { getOrCreateXmtpClient, dropXmtpClient } from 'xmtp-chat-rn';

await getOrCreateXmtpClient({ address, signer });   // idempotent per address
await dropXmtpClient();                             // on sign-out
```

Repeat calls for the same address share one in-flight client. A call for a
different address tears the previous one down first — without that, two
concurrent sign-ins burn two of XMTP's ten per-inbox installation slots.

The XMTP SDK's JS layer reads a global `Buffer` while encoding the signature it
hands to the native client, and Hermes does not provide one. Install it in your
entry file, before anything else imports the SDK:

```ts
import { Buffer } from 'buffer';
if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}
```

Without it, client creation fails and the SDK reports it as `User rejected
signature` — which sends you looking at your wallet rather than at the runtime.
Some apps get a `Buffer` transitively (`react-native-quick-crypto` provides
one); do not rely on that.

### 3. Render a thread

```tsx
import { useConversation, describeMessage, ReactionPills, BubbleMeta } from 'xmtp-chat-rn';

const { messages, reactions, send, toggleReaction, isLoading } = useConversation(peerAddress);

// messages is newest-first, ready for an inverted FlatList.
// Each carries `kind`; yours will be 'text' plus whatever cards you registered.
```

The package returns data and primitives, not a screen — you compose the shell,
the bubble bodies and any product-specific banners.

### Inbox and unread

```ts
const { conversations, refresh, reload } = useConversations();
const unread = useUnreadCount();
```

`ConversationSummary.last` is a `MessageDescription`, not a string — the package
renders no copy. Map it in your own layer:

```ts
function previewText(d: MessageDescription): string {
  switch (d.kind) {
    case 'text':     return d.text;
    case 'reaction': return d.fromMe ? `You reacted ${d.emoji}` : `Reacted ${d.emoji}`;
    case 'card':     return d.preview ?? d.fallback;
    case 'none':     return '';
  }
}
```

Use `isPreviewable(d)` for "is there anything to show" — an un-reaction and a
card with no fallback both describe as nothing, which is what keeps an unread
dot from appearing beside a blank row.

### Read receipts

Off unless you ask for them:

```ts
configureXmtpChat({ env: 'production', enabled: true, cards: [], readReceipts: true });
```

With the flag on, opening a thread that has something unread in it — or reading
a message that arrives while it is open — sends XMTP's `readReceipt` to the
counterparty. Telling someone when you read their message is a product decision
with a privacy cost and cannot be taken back per message, so the default is the
quiet one.

Receiving is not gated by the flag. A counterparty's receipt always decodes and
promotes your own text bubbles to `delivery: 'read'`, which `BubbleMeta` renders
as an accent-coloured double check. Receipts never appear in the thread, never
count toward unread, and never wake the device (the wire type sets
`shouldPush: false`). A receipt sent by a counterparty covers everything sent
before it, so it promotes the whole prefix rather than one bubble; card messages
keep no delivery state, so read shows on text bubbles only.

### Custom content types

A card is one `CardType` descriptor; pass the list to `configureXmtpChat`.

```ts
const invoice: CardType<'invoice', Invoice, 'invoice'> = {
  kind: 'invoice',                 // the ChatMessage discriminant
  payloadKey: 'invoice',           // the property the payload renders under
  codec: new InvoiceCodec(),       // your JSContentCodec
  is: (m) => m.contentTypeId?.startsWith('acme.example/invoice') ?? false,
  isValid: (c): c is Invoice => !!c && typeof (c as Invoice).total === 'string',
  // Optional. Omit `preview` and the codec's own text fallback is used; omit
  // `notification` and the card is silent, which is right for a passive card
  // that rides along with a message already carrying the push.
};
```

`ChatMessage<Cards, Extra>` derives its bubble union from the registry, so a
payload-key typo fails typecheck at the site that reads it. Send one with
`sendCard(peerAddress, invoice, payload)`.

### Background push

Registration is gated on a reachability probe, and that gate is not optional:
the native `XMTPPush` call runs on the shared XMTP runtime, so against a port
with no route it hangs and wedges the client — the inbox stops syncing
entirely. Supply both URLs; `probeUrl` is separate because the probe target
differs from the host the native client dials.

```ts
configureXmtpPush({ serverUrl, probeUrl });
await registerXmtpPush(client, fcmToken);   // after you obtain a device token
```

## Expo SDK ceiling

`@xmtp/react-native-sdk@5.7.0` does not compile against Expo SDK 57. Its
`XMTPModule.kt` registers 160 entries in a single `definition()` block, and
Expo's DSL functions are `inline`, so that whole registry expands into one JVM
method. Under `expo-modules-core` 57 it crosses the JVM's 64 KB per-method
limit and the Kotlin compiler stops:

```
MethodTooLargeException: Method too large:
expo/modules/xmtpreactnativesdk/XMTPModule.definition ()Lexpo/modules/kotlin/modules/ModuleDefinitionData;
```

No compiler flag, heap size or Gradle setting moves that — 64 KB is a limit of
the class file format itself. Expo 55 compiles it, which is what the example
app and this package's devDependencies pin. **Expo 56 is untested here**; the
break may land there rather than at 57.

This is upstream, not something a host can configure around:
[xmtp/xmtp-react-native#777](https://github.com/xmtp/xmtp-react-native/issues/777)
reports it, and 5.7.0 is the newest published version. That repository's last
commit was 2026-03-14 — as were the last commits to the iOS and Android SDKs —
while `libxmtp` and `xmtp-js` continue to ship. Treat an upstream fix as a
bonus rather than a plan: a host that needs a newer Expo will have to split
`definition()` itself with `patch-package`.

## Example app

`example/` is a runnable two-screen app — an inbox and a thread, with replies,
reactions, delivery state and one custom content type. It installs this package
from npm the way any consuming app does, so what it exercises is the published
artifact rather than the source beside it. See
[example/README.md](example/README.md) for how to run it; it needs a dev build,
because every peer dependency here is native.

## Status

Extracted from a production React Native app, where it ships today. It has 19
test suites / 149 tests covering the client lifecycle, message description,
delivery state, reactions, read receipts, the push reachability gate, the card
registry, the theme and the components.

It builds with `react-native-builder-bob` — CommonJS, ESM and declarations under
`lib/` — and typechecks and tests standalone, so it needs no resolver overrides
in the consuming app.

```
npm install xmtp-chat-rn
```

Version 0.0.1 is an early cut: the API is settled enough to use and not yet
frozen. It is 1:1-only by design (see Scope), and attachments are unimplemented.

It ships no native code of its own — no podspec, no `ios/`, no `android/` — so
it adds nothing for CocoaPods or Gradle to build. Every native requirement is a
peer dependency the host installs itself.

## Platform hooks

`configureXmtpChat` takes an optional `platform` object for host-supplied
native plumbing. All of it is optional, and an absent object behaves exactly
like a platform that provides none:

```ts
platform: {
  dbDirectory: () => appGroupContainerPath(),   // iOS App Group, so an extension can open the same MLS db
  setSharedItem: (key, value) => …,             // mirrors keys an extension reads
  migrateDbIfNeeded: () => …,                   // one-time relocation of an existing db
}
```

The keys written through `setSharedItem` are `xmtp.dbEncryptionKey` and
`xmtp.activeAddress`. If a notification extension reads them, those names are a
contract — renaming either breaks decrypted push previews with nothing failing.

## Copy and theming

The package emits no user-facing strings — components take their labels as props
with English defaults, and `describeMessage` returns a structured description the
host renders.

Theming is the same shape: `configureChatTheme(override)` merges a host's tokens
over brand-free defaults, and components read the result at render time. Call it
once during startup, before the first chat surface renders.

The contract is scoped to what these components actually draw — twelve colours, five
spacings, three radii, two text styles and one shadow — rather than a whole design
system. Anything omitted keeps its default, so a host can set three colours and
ignore the rest.

The accent is four tokens, not two. `accentSoft` is a background tinted toward the
accent; `onAccent` and `onAccentMuted` are content drawn on top of it. A pale accent
makes those look interchangeable, but a dark or saturated one needs them to move in
opposite directions.
