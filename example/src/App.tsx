/**
 * xmtp-chat-rn example — a two-screen demo of the whole package surface.
 *
 * Everything the package needs from a host is configured here at module scope,
 * before a component renders: the network, the card registry, and the theme.
 * `xmtpConfig()` throws rather than defaulting if a hook reaches it
 * unconfigured, so this is the file that has to run first.
 *
 * Signing in is the second half: build an XMTP `Signer`, hand it and its
 * address to `getOrCreateXmtpClient`, and start the one global inbound stream
 * that feeds the inbox listing and the unread count.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  clearActiveXmtpAddress,
  configureChatTheme,
  configureXmtpChat,
  dropXmtpClient,
  getOrCreateXmtpClient,
  setActiveXmtpAddress,
  startInboundMessages,
  stopInboundMessages,
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

type SignInState = 'connecting' | 'ready' | 'failed';

export default function App() {
  const [identity, setIdentity] = useState<DemoIdentity | null>(null);
  const [state, setState] = useState<SignInState>('connecting');
  // The open thread's counterparty, or null for the inbox. A real app would
  // reach for a navigator here; two screens do not need one.
  const [peer, setPeer] = useState<string | null>(null);

  const signIn = useCallback(async (next: DemoIdentity) => {
    setState('connecting');
    try {
      const client = await getOrCreateXmtpClient(next);
      setActiveXmtpAddress(next.address);
      // One stream for the whole app. The handler is where a real host would
      // raise a local notification; the demo wants only its side effect, which
      // is the activity signal that keeps the inbox and unread count live.
      await startInboundMessages(client, () => {});
      setState('ready');
    } catch (e) {
      console.warn('XMTP sign-in failed', e);
      setState('failed');
    }
  }, []);

  useEffect(() => {
    const stored = loadOrCreateIdentity();
    setIdentity(stored);
    void signIn(stored);
  }, [signIn]);

  // Become somebody else: tear the client down before the next one comes up,
  // which is also what a real app does on sign-out.
  const onRotate = useCallback(async () => {
    setState('connecting');
    setPeer(null);
    stopInboundMessages();
    await dropXmtpClient();
    clearActiveXmtpAddress();
    const next = rotateIdentity();
    setIdentity(next);
    await signIn(next);
  }, [signIn]);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        {state === 'ready' && identity ? (
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
            {state === 'connecting' ? (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.note}>Creating your XMTP inbox…</Text>
              </>
            ) : (
              <>
                <Text style={styles.note}>Could not reach XMTP.</Text>
                <TouchableOpacity
                  style={styles.retry}
                  onPress={() => identity && signIn(identity)}
                >
                  <Text style={styles.retryText}>Try again</Text>
                </TouchableOpacity>
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
