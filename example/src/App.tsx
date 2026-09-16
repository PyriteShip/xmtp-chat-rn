/**
 * xmtp-chat-rn example — a two-screen demo of the whole package surface.
 *
 * Everything the package needs from a host is configured here at module scope,
 * before a component renders: the network, the card registry, and the theme.
 * `xmtpConfig()` throws rather than defaulting if a hook reaches it
 * unconfigured, so this is the file that has to run first.
 *
 * Signing in is the second half: build an XMTP `Signer` and hand it and its
 * address to `getOrCreateXmtpClient`. What needs the client — here, the one
 * global inbound stream that feeds the inbox listing and the unread count —
 * hangs off `onXmtpClientReady`, not off that call, so a client the retry
 * recovers gets it too. The screen reads creation status from
 * `useXmtpClientStatus`, whose `retry` needs no identity from the screen.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  configureChatTheme,
  configureXmtpChat,
  dropXmtpClient,
  getOrCreateXmtpClient,
  onXmtpClientReady,
  startInboundMessages,
  stopInboundMessages,
  useXmtpClientStatus,
} from 'xmtp-chat-rn';
import { EXAMPLE_CARDS } from './nudge';
import { loadOrCreateIdentity, rotateIdentity, type DemoIdentity } from './identity';
import { InboxScreen } from './screens/InboxScreen';
import { ChatScreen } from './screens/ChatScreen';
import { colors, spacing } from './theme';

// `dev` and `production` are disjoint networks — an inbox on one is unreachable
// from the other. The demo uses `dev` so a throwaway identity costs nothing.
configureXmtpChat({
  env: 'dev',
  enabled: true,
  cards: EXAMPLE_CARDS,
  // No `platform`: those hooks exist for an iOS App Group shared with a
  // notification extension, which this demo has no use for.
});

// One stream for the whole app, started for every client that comes up — the
// first sign-in, a retry after a failure, or the next identity after a rotate.
// The handler is where a real host would raise a local notification; the demo
// wants only its side effect, the activity signal that keeps the inbox and
// unread count live. Subscribed at module scope, before any client exists,
// because a client already up when a listener subscribes is not replayed.
onXmtpClientReady((client) => {
  void startInboundMessages(client, () => {});
});

// Map this app's palette onto the package's scoped token set, so its
// components draw in the same visual language as the screens around them.
configureChatTheme({
  colors: {
    accent: colors.accent,
    accentSoft: colors.accentSoft,
    onAccent: colors.onAccent,
    onAccentMuted: colors.onAccentMuted,
    text: colors.text,
    textSoft: colors.textSoft,
    textMuted: colors.textMuted,
    border: colors.border,
    fill: colors.fill,
    surface: colors.surface,
    danger: colors.danger,
    dangerSoft: colors.dangerSoft,
  },
  spacing,
});

/** Start creation; a failure lands in `useXmtpClientStatus`, not here. */
function signIn(identity: DemoIdentity): void {
  getOrCreateXmtpClient(identity).catch(() => {});
}

export default function App() {
  const [identity, setIdentity] = useState<DemoIdentity | null>(null);
  const { status, retry } = useXmtpClientStatus();
  // The open thread's counterparty, or null for the inbox. A real app would
  // reach for a navigator here; two screens do not need one.
  const [peer, setPeer] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadOrCreateIdentity();
    setIdentity(stored);
    signIn(stored);
  }, []);

  // Become somebody else: tear the client down before the next one comes up,
  // which is also what a real app does on sign-out.
  const onRotate = useCallback(async () => {
    setPeer(null);
    stopInboundMessages();
    await dropXmtpClient();
    const next = rotateIdentity();
    setIdentity(next);
    signIn(next);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        {status.state === 'ready' && identity ? (
          peer ? (
            <ChatScreen peerAddress={peer} onBack={() => setPeer(null)} />
          ) : (
            <InboxScreen
              address={identity.address}
              onOpenChat={setPeer}
              onRotateIdentity={onRotate}
            />
          )
        ) : (
          <View style={styles.center}>
            {status.state === 'failed' ? (
              <>
                <Text style={styles.note}>Could not reach XMTP.</Text>
                <TouchableOpacity style={styles.retry} onPress={() => void retry()}>
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.note}>Creating your XMTP inbox…</Text>
              </>
            )}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  note: { color: colors.textSoft, fontSize: 15 },
  retry: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
  },
  retryText: { color: colors.onAccent, fontWeight: '600' },
});
