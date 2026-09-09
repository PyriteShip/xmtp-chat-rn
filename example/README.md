# xmtp-chat-rn example

A two-screen chat app built on [`xmtp-chat-rn`](../README.md): an inbox and a
thread, with replies, reactions, delivery state and one custom content type.

It installs the package from npm the way any consuming app would, so what it
exercises is the published artifact — the `exports` map and the built `lib/`,
not the source next door.

## Run it

You need a dev build. Expo Go cannot run this: the package's peer dependencies
(the XMTP SDK, MMKV, quick-base64, haptics, vector icons) are all native.

**The Expo SDK version is pinned to 55 on purpose.** `@xmtp/react-native-sdk`
does not compile against Expo 57 — its `XMTPModule.definition()` exceeds the
JVM's 64 KB method limit under `expo-modules-core` 57. See "Expo SDK ceiling"
in the [package README](../README.md). Do not bump `expo` here expecting it to
build.

```
cd example
npm install
npx expo prebuild        # generates ios/ and android/
npm run ios              # or: npm run android
```

## Use it

The app mints a throwaway wallet on first launch and shows its address. To hold
a conversation you need two of them:

1. **Two devices or simulators.** Run the app twice, copy one address, paste it
   into the other's address bar.
2. **One device.** Copy your address somewhere, tap **New identity**, then paste
   the old address in. You are now two people who can message each other, though
   only one at a time.

The demo runs on XMTP's `dev` network, which is disjoint from `production` — a
`dev` inbox is unreachable from a production client and vice versa.

## What is where

| File | What it shows |
|---|---|
| `index.ts` | The two polyfills the SDK needs: `crypto.getRandomValues` and a global `Buffer` |
| `src/App.tsx` | `configureXmtpChat` / `configureChatTheme` at module scope, client creation, the global inbound stream |
| `src/identity.ts` | Building an XMTP `Signer` — the seam where a real wallet goes |
| `src/nudge.ts` | A custom content type: the codec, and the `CardType` that registers it |
| `src/messages.ts` | Instantiating `ChatMessage` for this app's registry, and rendering a `MessageDescription` into copy |
| `src/screens/InboxScreen.tsx` | `useConversations`, `useUnreadCount` |
| `src/screens/ChatScreen.tsx` | `useConversation`, `sendCard`, and every shipped component |
| `src/components/MessageBubble.tsx` | The bubble the package deliberately does not ship |

## What it leaves out

**Background push.** It needs a server to run — see the package README — and
registration is gated on a reachability probe that hangs the client if you point
it at a dead port. A demo is the wrong place to learn that.

**A real wallet.** `identity.ts` keeps a private key in unencrypted MMKV. It is
the smallest thing that satisfies the `Signer` contract and nothing more; a real
app brings WalletConnect, an embedded wallet or a smart account, and the package
does not care which.

**Attachments.** Unimplemented in the package.

## Developing against local changes

By default the example installs `xmtp-chat-rn` from npm. To point it at the
working tree instead:

```
npm run use-local        # packs ../ and installs the tarball
```

Re-run it after each change to the package — it installs a build, not a symlink,
which is the point.
