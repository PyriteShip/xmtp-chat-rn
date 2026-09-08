# xmtp-chat-rn

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
with delivery state, replies and reactions, consent-based blocking, background push
registration, a registry for a host's own content types, and seven chat components
(bubble meta, quoted message, reaction pills, swipe-to-reply, scroll-to-latest,
message actions, failed-send notice).

What is not: a chat screen. The components are primitives a host composes; the
screen shell, the bubble bodies and any product-specific banners stay in the host.

### Compared to a hosted chat API

Stream and Sendbird will do things this does not. They ship groups, typing
indicators, read receipts, moderation, search, threads and attachments, plus a
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

## Status

Extracted from a production React Native app, where it ships today. It has 14
test suites covering the client lifecycle, message description, delivery state,
reactions, the push reachability gate and the card registry.

It is **not yet packaged for consumers**: there is no build step, so `main`
points at TypeScript source. A consumer today resolves it to source the way the
originating app does — a `paths` entry for `tsc`, a `moduleNameMapper` for jest,
and a `resolveRequest` for Metro. Publishing properly means adding
`react-native-builder-bob` and emitting `lib/`; see the issues.

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
