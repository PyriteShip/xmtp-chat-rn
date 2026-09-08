// The theme is read at render time, so a host can configure during startup and
// every component still picks it up. Two properties make that safe: an override
// merges over the defaults rather than replacing them wholesale (a host that
// sets three colours does not lose the other seven), and the merged result is a
// stable reference so components can use it as a `useMemo` dependency without
// rebuilding styles on every render.
import { chatTheme, configureChatTheme, defaultChatTheme, __resetChatTheme } from './theme';

beforeEach(() => __resetChatTheme());

test('an unconfigured host renders on the shipped defaults', () => {
  expect(chatTheme()).toEqual(defaultChatTheme);
});

test('an override merges over the defaults instead of replacing them', () => {
  configureChatTheme({ colors: { accent: '#c9440e' } });
  const t = chatTheme();
  expect(t.colors.accent).toBe('#c9440e');
  expect(t.colors.surface).toBe(defaultChatTheme.colors.surface);
  expect(t.spacing).toEqual(defaultChatTheme.spacing);
});

test('the merged theme is a stable reference between reads', () => {
  configureChatTheme({ colors: { accent: '#c9440e' } });
  expect(chatTheme()).toBe(chatTheme());
});

test('configuring again replaces the previous override rather than layering on it', () => {
  configureChatTheme({ colors: { accent: '#111111' } });
  configureChatTheme({ colors: { surface: '#222222' } });
  const t = chatTheme();
  expect(t.colors.surface).toBe('#222222');
  expect(t.colors.accent).toBe(defaultChatTheme.colors.accent);
});

// The accent pair is four tokens because content drawn ON the accent and a
// background tinted TOWARD it move in opposite directions once the accent is
// dark. A host must be able to set them independently.
test('the four accent tokens are independently settable', () => {
  configureChatTheme({
    colors: { accent: '#1a1a1a', accentSoft: '#ededed', onAccent: '#ffffff', onAccentMuted: '#b0b0b0' },
  });
  const { colors } = chatTheme();
  expect([colors.accent, colors.accentSoft, colors.onAccent, colors.onAccentMuted])
    .toEqual(['#1a1a1a', '#ededed', '#ffffff', '#b0b0b0']);
});
