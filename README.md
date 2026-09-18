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
with delivery state, replies, reactions and read receipts, consent-based blocking, attachments over host-supplied storage, background push
registration, a registry for a host's own content types, and seven chat components
(bubble meta, quoted message, reaction pills, swipe-to-reply, scroll-to-latest,
message actions, failed-send notice).

What is not: a chat screen. The components are primitives a host composes; the
screen shell, the bubble bodies and any product-specific banners stay in the host.

### Compared to a hosted chat API

Stream and Sendbird will do things this does not. They ship groups, typing
indicators, moderation, search and threads, plus a
dashboard and a support contract. If you need those, buy them — this is not a
drop-in replacement and pretending otherwise wastes your time.

What they cannot do is let someone message your user from a different app, or
avoid holding your users' messages, or bill nothing per monthly active user.

Two costs this does not remove. **Attachments need storage you run** — the
package encrypts them and speaks XMTP's standard format, but the ciphertext has
to live somewhere, and you pay for that bucket. And **background push needs a
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
  devInstallationPrune: __DEV__, // optional, see Installation cap
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

#### When creation fails

Creation is one signature-bearing async step, and it fails for reasons outside
your app: a network drop, a wallet signature that stalls or is declined, the
installation cap below. The package keeps the failure and the identity behind
it, so any surface can recover without re-supplying a signer:

```tsx
import { useXmtpClientStatus } from 'xmtp-chat-rn';

const { status, retry } = useXmtpClientStatus();
if (status.state === 'failed') {
  return <Retry onPress={retry} />;       // status.error has the reason, for logs
}
```

`status.state` is `idle` (nothing requested, or signed out), `initializing`,
`ready` or `failed`. `retry` (also `retryXmtpClient()`) re-runs creation for the
identity that failed, joins an attempt already in flight, and resolves `null`
rather than rejecting when it fails again. Without it, a failed creation stays
failed until the app restarts.

A creation that hangs rather than fails — a signature request nobody answers, a
network call that never returns — is abandoned after `clientCreateTimeoutMs`
(default 60 000; `null` disables it). The attempt rejects with
`XmtpClientCreateTimeoutError` (recognise it with
`isXmtpClientCreateTimeoutError`), status turns `failed`, and the next call or
`retry` starts a fresh attempt. If the abandoned attempt succeeds later and
nothing has started since, its client is adopted and announced; if a newer
attempt exists, the late client is ignored.

Deciding when to retry *unprompted* is yours: creation may need a signature, and
for a wallet that signs in another app, an automatic retry is an app switch
nobody asked for.

**Hang post-create wiring on readiness, not on your own call.** Anything that
needs the client — message notifications, push registration — belongs in
`onXmtpClientReady`, which runs for every client that comes up, whichever
surface started or retried it:

```ts
onXmtpClientReady((client, address) => {
  startMessageNotifications(client);
  registerPush(client, address);
});
```

Wiring placed after `await getOrCreateXmtpClient(...)` runs only for that one
call, so a client a retry recovers comes up without it. Subscribe at startup,
before creating a client — one that is already ready is not replayed.

#### Installation cap

XMTP allows ten installations per inbox, and each wiped-database reinstall (an
emulator `pm clear`, a fresh simulator) registers a new one, so a dev wallet
eventually hits the cap and `Client.create` rejects with
`already registered 10/10 installations`. With `devInstallationPrune: true`, the
package recovers from exactly that failure: it revokes the inbox's **oldest**
installation (by `createdAt`) — only as many as free one slot — and retries
create once. Leave it off in production builds: revocation needs a wallet
signature, and the oldest installation may be the user's other phone.

A sign-in that succeeds never revokes anything, on any configuration. A revoked
installation keeps working locally and appears to send, but every recipient
drops its messages, so revoking another device's installation is silent, total
message loss for that device.

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

### Attachments

Attachments use XMTP's standard remote attachment, so any XMTP client can open
the ones you send and you can open theirs. The file is encrypted on the device;
you supply where the ciphertext is stored.

Everything below needs `attachments` configured. Without it, `sendAttachment`
and `openAttachment` throw `AttachmentsNotConfiguredError`, and an *inbound*
remote attachment from another client degrades rather than appearing as a
kind this app can't render: in the thread it's a `kind: 'text'` bubble
carrying the codec's fallback string, and in the inbox it's `{ kind: 'card',
cardKind: 'remoteAttachment', preview: null, fallback }` — the same treatment
an inline static attachment (sent by another client) always gets. This is
what lets a host upgrade to a version of this package that supports
attachments without wiring up storage on day one, and without its existing
bubble/inbox code crashing on a kind it has never seen.

```ts
import { configureXmtpChat, createPresignedPutUploader } from 'xmtp-chat-rn';
import { File, Paths } from 'expo-file-system';

configureXmtpChat({
  // ...
  attachments: {
    // Your server returns a signed PUT for the object key; never ship bucket
    // credentials in the app. `file.byteLength` is the native SDK's reported
    // size, which is the PLAINTEXT attachment's size, not the ciphertext's —
    // the ciphertext PUT to `uploadUrl` is somewhat larger (the encoded-
    // content wrapper plus the GCM auth tag). Treat it as approximately the
    // stored size; do not have your presign server sign an exact
    // `Content-Length` computed from it, or the PUT will fail the signature.
    upload: createPresignedPutUploader((file) =>
      api.post('/attachments/presign', { key: file.contentDigest, bytes: file.byteLength }),
    ),
    download: async (url) => (await File.downloadFileAsync(url, Paths.cache, { idempotent: true })).uri,
    maxBytes: 25_000_000, // the default
  },
});
```

The `download` line targets the `expo-file-system` API that ships with Expo 55;
any function that writes the URL to a local file and returns its `file://` URI
works. `downloadFileAsync` names the local file after the URL's last path
segment, which is fine when your URL is keyed by digest or CID (unique per
file) but will collide if yours isn't — use a destination you know is unique
in that case.

Both `createPresignedPutUploader` and `createProxyUploader` bound their upload
`fetch` with `timeoutMs`, defaulting to `DEFAULT_UPLOAD_TIMEOUT_MS` (60s) so a
hung upload fails the bubble instead of leaving it pending forever; pass `0`
or a negative value to disable it. (`createIpfsUploader`'s `pin` is your own
function, so it isn't bounded here — apply your own timeout inside it if you
want one.)

Send from the thread hook, and render with `useAttachment`:

```tsx
const { sendAttachment } = useConversation(peerAddress);
await sendAttachment({ fileUri, mimeType: 'image/jpeg', filename: 'photo.jpg' });

function AttachmentBubble({ message }) {
  const { status, load } = useAttachment(message.attachment);
  const file = message.localFile ?? (status.state === 'ready' ? status.file : null);
  const mimeType = message.localFile?.mimeType ?? (status.state === 'ready' ? status.file.mimeType : undefined);
  if (file && mimeType?.startsWith('image/')) return <Image source={{ uri: file.fileUri }} />;
  if (file) return <FileRow filename={file.filename} />; // any non-image type
  if (status.state === 'failed') return <Retry onPress={load} />;
  return <Spinner />;
}
```

Branch on mime type, not on whether a URI exists: `<Image>` only makes sense
for `image/*`, and other types (PDFs, audio, arbitrary files) need a file row
showing the filename instead. A message's own `localFile` and a loaded
`status.file` both carry `mimeType`, so the check works before and after
upload finishes. A pending attachment's `id` is a local id (not yet the
network message id), same as pending text — don't offer reactions or replies
on it until it reconciles.

`sendAttachment` behaves like `send`: a pending bubble at once, `failed` with
tap-to-retry on a network error (a retry reuses the finished upload). The two
rejections are `AttachmentTooLargeError` and `AttachmentsNotConfiguredError`
(no `attachments` configured), both of which also remove the bubble — neither
is fixed by retrying.

`maxBytes` is a backstop, not a memory guard: the check runs after the native
SDK has already encrypted the file, which means it already read the whole
thing into memory. If you care about the memory cost of a large pick (video,
a big PDF), check the file's size yourself — before calling `sendAttachment`
— rather than relying on this option to stop it early.

**Your storage URL must be:**

1. `https://` — the SDK accepts no other scheme, so IPFS goes through a gateway.
2. Permanent — a presigned GET expires within 7 days and breaks old messages.
3. Readable without auth headers — other clients send a bare GET.
4. CORS-open to GET from any origin — browser clients such as xmtp.chat cannot
   fetch it otherwise.

#### What storage can see

The stored file is ciphertext. Each file gets its own random key (AES-256-GCM),
and that key travels only inside the XMTP message, which MLS encrypts to the
conversation. So the storage provider, and anyone who finds the URL, can
download the file but not read it.

Public ciphertext still reveals the file's size, when it was uploaded, and
whatever your storage account and the uploader's IP address tie it to. The
filename and type are not exposed; they travel inside the encrypted message.

#### What the sender can learn

`useAttachment`'s default (`autoLoad: true`) means the recipient's device
fetches whatever https URL a message names as soon as the bubble mounts —
with no tap, and independent of read receipts. A sender who controls that
URL's server (their own bucket, or an IPFS gateway they operate) therefore
learns the recipient's IP address and roughly when they opened the thread,
even with read receipts off and even if the recipient never "reads" the
message in any UI sense. This is the same tracking-pixel shape as email, just
over a storage GET instead of an `<img>` fetch.

Pass `autoLoad: false` (and gate loading behind a tap) for threads with a
sender the user hasn't accepted, or more broadly whenever the app can't vouch
for who controls the storage a given attachment names.

Separately: the native SDK writes each decrypted file to the OS temp
directory on every open, and nothing in this package deletes it. A host that
wants decrypted plaintext not to outlive the session should clean up the
`fileUri` a `status.state === 'ready'` result names.

#### S3/R2 or IPFS

**S3 or R2 (recommended).** Deleting the object revokes access for everyone,
even if a message key later leaks from a compromised device. R2 charges no
egress, which matters because every recipient downloads every file.

Use `createPresignedPutUploader` (above) when your server can hand the device
a signed URL to PUT straight to the bucket. If instead your server holds the
storage binding itself — e.g. a Cloudflare Worker with an R2 binding, where no
presigned URL is ever minted and no storage credential exists anywhere the
device can see — use `createProxyUploader` and let the ciphertext flow through
your own endpoint:

```ts
import { configureXmtpChat, createProxyUploader } from 'xmtp-chat-rn';

configureXmtpChat({
  // ...
  attachments: {
    upload: createProxyUploader({
      endpoint: 'https://worker.example.com/attachments/upload',
      headers: async (file) => ({ authorization: `Bearer ${await getAccessToken()}` }),
      // Defaults to POST, and to reading `{ url }` from a JSON response —
      // both match a typical Worker route.
    }),
    download: async (url) => (await File.downloadFileAsync(url, Paths.cache, { idempotent: true })).uri,
  },
});
```

```ts
// Worker route: key the R2 object by the digest header, not by parsing the
// (potentially large) body — createProxyUploader sends it as a header
// precisely so you can decide this before or without touching the body.
export default {
  async fetch(req: Request, env: Env) {
    const digest = req.headers.get('x-attachment-digest');
    if (!digest) return new Response('missing digest', { status: 400 });
    await env.ATTACHMENTS.put(digest, req.body);
    return Response.json({ url: `https://cdn.example.com/${digest}` });
  },
};
```

**IPFS (opt-in).** Use `createIpfsUploader({ pin, gateway })`, where `pin` stores
the ciphertext through your server and resolves the CID, and `gateway` is your
dedicated `https://` gateway (public gateways throttle). Understand the trade
first: **an IPFS file cannot be reliably deleted.** Unpinning does not remove
copies other nodes and gateways have cached. The file is therefore only as
private as its key, for as long as any copy exists — if a recipient's device or
chat database leaks years later, the file is readable then. MLS forward secrecy
does not help, because it protects message keys, not a file already public on
IPFS.

**Not supported yet:** several files in one message (XMTP's multi remote
attachment) — it is not registered, so it does not decode and does not appear
in the thread. An inline static attachment from another client (bytes on the
wire, no upload) does decode, but only far enough to show its text fallback
rather than the image or file itself.

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

### Decrypted push previews

A push carries ciphertext, so a notification says "New message" unless something
opens the MLS database and processes the envelope. `decryptPushedMessage` does
that, from an Android headless JS task or an iOS Notification Service Extension:

```ts
const preview = await decryptPushedMessage(
  { topic: data.topic, encryptedMessage: data.encryptedMessage },
  {
    buildClient,                               // no-signer Client.build with your codecs
    getActiveClient: () => getActiveXmtpClient(),
    dropClient,                                // the SDK's dropClient
    render: async (decoded, client) => ({ title: …, body: … }),
  },
);
// null => show generic copy
```

Those two field names match XMTP's reference notification server;
`encryptedMessage` is the base64 `GroupMessage` protobuf, not its inner payload.
A server emitting other names maps them here.

It returns `null` for every miss — no client, unknown conversation, decrypt
error, timeout — so one fallback branch covers all of them. Rendering is yours
because the content types are: `render` is where a custom card becomes a title
and a body, and the same function should back the foreground notification so
both paths read identically.

Two constraints the deps encode. Only one client may hold the MLS database, so a
live client is reused when the app is alive and only a client the receiver built
is dropped. And background work is killed on a budget, so the decrypt races a
timeout (6s by default); if the timeout wins, `processMessage` still settles in
the background and the OS reclaims the handle.

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

Extracted from a production React Native app, where it ships today. It has 27
test suites / 222 tests covering the client lifecycle, message description,
delivery state, reactions, read receipts, attachments, the push reachability
gate, the card registry, the theme and the components.

It builds with `react-native-builder-bob` — CommonJS, ESM and declarations under
`lib/` — and typechecks and tests standalone, so it needs no resolver overrides
in the consuming app.

```
npm install xmtp-chat-rn
```

Version 0.0.1 is an early cut: the API is settled enough to use and not yet
frozen. It is 1:1-only by design (see Scope).

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
