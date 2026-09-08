import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { chatTheme, type ChatTheme } from '../theme';

const HAPTIC_OPTIONS = { enableVibrateFallback: true, ignoreAndroidSystemSettings: false } as const;

/**
 * Returns the row to rest. No bounce — a bubble that wobbles back under the
 * finger reads as a glitch rather than a spring.
 */
const SETTLE_SPRING = { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 20 } as const;

/** Drag past this (in px of finger travel) and releasing fires the reply. */
const THRESHOLD = 56;
/** Furthest the row will travel — beyond this the drag stops tracking 1:1. */
const MAX_TRAVEL = 76;
/** Finger travel needed before we claim the gesture from the list's scroll. */
const CLAIM_DX = 14;
/** Vertical slop tolerated while claiming — beyond it the gesture is a scroll. */
const CLAIM_DY = 12;

/**
 * Signal's swipe-to-reply: drag a message right, feel a tick when it arms, let
 * go to reply. A reply arrow fades in behind the row as it travels.
 *
 * Built on RN's own PanResponder rather than a gesture library because the app
 * has no gesture-handler dependency and this needs no native module. The
 * responder only claims the gesture once the drag is decisively horizontal
 * (`CLAIM_DX` across with less than `CLAIM_DY` of vertical drift), so the
 * thread still scrolls normally and a diagonal flick is read as a scroll.
 *
 * Travel is damped and capped: past `MAX_TRAVEL` the row stops following the
 * finger, so a long drag can't tear the bubble off the screen. Arming is
 * hysteretic — dragging back under the threshold disarms and re-arms, each
 * transition ticking the haptic, so the gesture is legible without looking.
 */
export function SwipeToReply({
  enabled,
  onReply,
  children,
}: {
  /** False for rows that can't be replied to (timeline entries, unsent messages). */
  enabled: boolean;
  onReply: () => void;
  children: React.ReactNode;
}) {
  const theme = chatTheme();
  const styles = React.useMemo(() => makeStyles(theme), [theme]);
  const travel = useRef(new Animated.Value(0)).current;
  // Whether releasing now would fire. A ref, not state: it is read inside the
  // responder callbacks and must never re-create them mid-gesture.
  const armed = useRef(false);

  const responder = useMemo(() => {
    // Every way the gesture can end routes through here, so disarming and
    // settling can never drift apart between the two exits.
    const settle = () => {
      armed.current = false;
      Animated.spring(travel, SETTLE_SPRING).start();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        enabled && g.dx > CLAIM_DX && Math.abs(g.dy) < CLAIM_DY,
      onPanResponderMove: (_, g) => {
        // Damped past the threshold so the row eases into its stop rather
        // than slamming against the cap.
        const raw = Math.max(0, g.dx);
        const x = raw <= THRESHOLD ? raw : THRESHOLD + (raw - THRESHOLD) * 0.25;
        travel.setValue(Math.min(x, MAX_TRAVEL));
        const nowArmed = raw >= THRESHOLD;
        if (nowArmed !== armed.current) {
          armed.current = nowArmed;
          ReactNativeHapticFeedback.trigger('impactLight', HAPTIC_OPTIONS);
        }
      },
      onPanResponderRelease: () => {
        const fire = armed.current;
        settle();
        if (fire) onReply();
      },
      onPanResponderTerminate: settle,
    });
  }, [enabled, onReply, travel]);

  // The arrow only resolves as the row commits to the gesture, so a nudge
  // during a scroll doesn't flash an affordance the user didn't ask for.
  const arrowOpacity = travel.interpolate({
    inputRange: [0, THRESHOLD * 0.4, THRESHOLD],
    outputRange: [0, 0.35, 1],
    extrapolate: 'clamp',
  });
  const arrowScale = travel.interpolate({
    inputRange: [0, THRESHOLD],
    outputRange: [0.7, 1],
    extrapolate: 'clamp',
  });

  if (!enabled) return <>{children}</>;

  return (
    <View>
      <Animated.View
        pointerEvents="none"
        style={[styles.arrow, { opacity: arrowOpacity, transform: [{ scale: arrowScale }] }]}
      >
        <View style={styles.arrowPuck}>
          <Icon name="reply" size={16} color={theme.colors.accent} />
        </View>
      </Animated.View>
      <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: travel }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

function makeStyles(t: ChatTheme) {
  return StyleSheet.create({
  // Sits behind the row at its left edge; the row slides right to reveal it.
  arrow: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowPuck: {
    width: 28,
    height: 28,
    borderRadius: t.radius.pill,
    backgroundColor: t.colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  });
}
