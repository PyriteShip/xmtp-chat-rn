/**
 * Design tokens the chat components render with.
 *
 * Scoped to exactly what these components draw — a host configures ~20 values,
 * not a whole design system. Defaults are a neutral grey/blue so a host that
 * configures nothing still renders something plain and legible rather than
 * inheriting another product's brand.
 *
 * `configureChatTheme` is read at render time, never at module scope: styles are
 * built inside each component with `useMemo` over `chatTheme()`, so a host can
 * configure during app startup and every component still picks it up. Building
 * styles at module scope would freeze the defaults before any host code runs.
 *
 * The accent pair is deliberately four tokens rather than two. `accentSoft` is a
 * background tinted toward the accent; `onAccent` and `onAccentMuted` are content
 * drawn ON the accent. In a pale-accent palette those collapse to similar values,
 * but a dark or saturated accent needs them to move in opposite directions.
 */
import { type TextStyle, type ViewStyle } from 'react-native';

export interface ChatThemeColors {
  /** Own-bubble background, active pill border, reply affordance, scroll-to-latest. */
  accent: string;
  /** Background tinted toward the accent: your own reaction pill, swipe track. */
  accentSoft: string;
  /** Full-strength content on an accent background (quoted author, FAB glyph). */
  onAccent: string;
  /** Secondary content on an accent background (timestamps, quote preview). */
  onAccentMuted: string;
  /** Subtle filled background drawn ON the accent — `fill`'s counterpart there. */
  onAccentFill: string;
  /**
   * Own-bubble background. The components draw nothing with it; it is the
   * value a host's own bubble uses, kept here so the on-bubble tokens below
   * have a stated background to be legible against. Follows `accent` unless set.
   */
  ownBubble: string;
  /** Full-strength content inside an own bubble (quoted author and rail, read glyph). Follows `onAccent` unless set. */
  onOwnBubble: string;
  /** Secondary content inside an own bubble (timestamp, quote preview). Follows `onAccentMuted` unless set. */
  onOwnBubbleMuted: string;
  /** Subtle filled background inside an own bubble (the quote wash). Follows `onAccentFill` unless set. */
  onOwnBubbleFill: string;
  /** Full-screen dim behind a modal sheet. */
  scrim: string;
  /** A send that failed: the notice text and its discard control. */
  danger: string;
  /** Background of a failed bubble — `danger` at low emphasis. */
  dangerSoft: string;
  /** Primary text and icons. */
  text: string;
  /** Secondary text. */
  textSoft: string;
  /** Tertiary text: timestamps, counts. */
  textMuted: string;
  /** Hairlines and pill borders. */
  border: string;
  /** Subtle filled background inside a surface (quoted row, sheet slot). */
  fill: string;
  /** Card, sheet and pill background. */
  surface: string;
}

export interface ChatTheme {
  colors: ChatThemeColors;
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  radius: { sm: number; lg: number; pill: number };
  /** The two text styles these components use; a host maps its own scale onto them. */
  text: { body: TextStyle; bodySmall: TextStyle };
  /** Elevation for the floating scroll-to-latest control. */
  shadow: { lift: ViewStyle };
}

/** Brand-free defaults. A host overrides what it cares about via configureChatTheme. */
export const defaultChatTheme: ChatTheme = {
  colors: {
    accent: '#3b6ea5',
    accentSoft: '#e4ecf5',
    onAccent: '#ffffff',
    onAccentMuted: '#d6e2f0',
    onAccentFill: 'rgba(255,255,255,0.16)',
    ownBubble: '#3b6ea5',
    onOwnBubble: '#ffffff',
    onOwnBubbleMuted: '#d6e2f0',
    onOwnBubbleFill: 'rgba(255,255,255,0.16)',
    scrim: 'rgba(28,30,33,0.45)',
    danger: '#b3271d',
    dangerSoft: '#f7e4e1',
    text: '#1c1e21',
    textSoft: '#65686c',
    textMuted: '#8a8d91',
    border: '#e3e5e8',
    fill: '#f0f2f5',
    surface: '#ffffff',
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 8, lg: 16, pill: 999 },
  text: {
    body: { fontSize: 15, fontWeight: '400', lineHeight: 22 },
    bodySmall: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  },
  shadow: {
    lift: {
      shadowColor: '#1c1e21',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 16,
      elevation: 4,
    },
  },
};

/** A host may override any subset; anything omitted keeps its default. */
export interface ChatThemeOverride {
  colors?: Partial<ChatThemeColors>;
  spacing?: Partial<ChatTheme['spacing']>;
  radius?: Partial<ChatTheme['radius']>;
  text?: Partial<ChatTheme['text']>;
  shadow?: Partial<ChatTheme['shadow']>;
}

let current: ChatTheme = defaultChatTheme;

/**
 * Merge a host's tokens over the defaults. Call once during startup, before the
 * first chat surface renders. The merged result is cached, so `chatTheme()`
 * returns a stable reference that is safe as a `useMemo` dependency.
 *
 * The own-bubble tokens a host leaves unset follow the merged accent tokens, so
 * a host whose own bubbles are the accent sets the accent alone, and one whose
 * own bubbles are a pale tint sets the four own-bubble tokens to match it.
 */
export function configureChatTheme(override: ChatThemeOverride): void {
  const colors = { ...defaultChatTheme.colors, ...override.colors };
  const set = override.colors ?? {};
  current = {
    colors: {
      ...colors,
      ownBubble: set.ownBubble ?? colors.accent,
      onOwnBubble: set.onOwnBubble ?? colors.onAccent,
      onOwnBubbleMuted: set.onOwnBubbleMuted ?? colors.onAccentMuted,
      onOwnBubbleFill: set.onOwnBubbleFill ?? colors.onAccentFill,
    },
    spacing: { ...defaultChatTheme.spacing, ...override.spacing },
    radius: { ...defaultChatTheme.radius, ...override.radius },
    text: { ...defaultChatTheme.text, ...override.text },
    shadow: { ...defaultChatTheme.shadow, ...override.shadow },
  };
}

/** The active theme. Read inside a component body, never at module scope. */
export function chatTheme(): ChatTheme {
  return current;
}

/** Test seam: restore the shipped defaults. */
export function __resetChatTheme(): void {
  current = defaultChatTheme;
}
