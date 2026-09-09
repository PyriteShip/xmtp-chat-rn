/**
 * The example app's own palette. `configureChatTheme` (called in App.tsx) maps
 * these onto the package's scoped token set, so the components it draws match
 * the screens around them — the same job a real host does with its design
 * system.
 */

export const colors = {
  accent: '#2f6f5e',
  accentSoft: '#dcece7',
  onAccent: '#ffffff',
  onAccentMuted: '#bcd8cf',
  text: '#14181d',
  textSoft: '#4a5561',
  textMuted: '#8b96a3',
  border: '#dfe4ea',
  fill: '#f1f4f7',
  surface: '#ffffff',
  danger: '#c0392b',
  dangerSoft: '#fbeae8',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 6, md: 12, lg: 18 };
