import {
  applyReactionPlan,
  summarizeReactions,
  myReaction,
  reactionPlan,
  groupReactions,
  mergeReaction,
  type ReactionEvent,
} from './chatReactions';

const ME = 'inbox-me';
const THEM = 'inbox-them';
const THIRD = 'inbox-third';

let seq = 0;
function ev(
  senderInboxId: string,
  emoji: string,
  action: 'added' | 'removed' = 'added',
  sentNs = ++seq,
): ReactionEvent {
  return { reference: 'msg-1', senderInboxId, emoji, action, sentNs };
}

beforeEach(() => {
  seq = 0;
});

describe('summarizeReactions', () => {
  it('tallies one pill per emoji and flags the signed-in user', () => {
    const out = summarizeReactions([ev(ME, '👍'), ev(THEM, '👍'), ev(THIRD, '❤️')], ME);
    expect(out).toEqual([
      { emoji: '👍', count: 2, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
  });

  it('orders pills by when each emoji was first used, not by count', () => {
    const out = summarizeReactions(
      [ev(ME, '😮'), ev(THEM, '👍'), ev(THIRD, '👍')],
      ME,
    );
    expect(out.map((r) => r.emoji)).toEqual(['😮', '👍']);
  });

  it('replaces a sender\'s reaction rather than stacking it (Signal: one per person)', () => {
    const out = summarizeReactions([ev(ME, '👍'), ev(ME, '❤️')], ME);
    expect(out).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
  });

  it('drops a reaction the sender removed', () => {
    const out = summarizeReactions([ev(ME, '👍'), ev(ME, '👍', 'removed')], ME);
    expect(out).toEqual([]);
  });

  it('ignores a late removal naming an emoji the sender already replaced', () => {
    // Regression: replaying out of order must not let a stale removal of 👍
    // wipe the ❤️ that superseded it.
    const events = [
      ev(ME, '👍', 'added', 10),
      ev(ME, '❤️', 'added', 20),
      ev(ME, '👍', 'removed', 30),
    ];
    expect(summarizeReactions(events, ME)).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
  });

  it('resolves by send time regardless of array order', () => {
    const events = [ev(ME, '❤️', 'added', 20), ev(ME, '👍', 'added', 10)];
    expect(summarizeReactions(events, ME)).toEqual([{ emoji: '❤️', count: 1, mine: true }]);
  });

  it('does not mutate the caller\'s array', () => {
    const events = [ev(ME, '❤️', 'added', 20), ev(THEM, '👍', 'added', 10)];
    const snapshot = [...events];
    summarizeReactions(events, ME);
    expect(events).toEqual(snapshot);
  });

  it('returns no pills for an empty log', () => {
    expect(summarizeReactions([], ME)).toEqual([]);
  });

  it('flags nothing as mine when signed out', () => {
    expect(summarizeReactions([ev(ME, '👍')], null)).toEqual([
      { emoji: '👍', count: 1, mine: false },
    ]);
  });
});

describe('myReaction', () => {
  it('returns the emoji currently held', () => {
    expect(myReaction([ev(ME, '👍'), ev(THEM, '❤️')], ME)).toBe('👍');
  });

  it('returns null once cleared', () => {
    expect(myReaction([ev(ME, '👍'), ev(ME, '👍', 'removed')], ME)).toBeNull();
  });

  it('returns null when signed out', () => {
    expect(myReaction([ev(ME, '👍')], null)).toBeNull();
  });
});

describe('reactionPlan', () => {
  it('adds when the user holds nothing', () => {
    expect(reactionPlan([], ME, '👍')).toEqual([{ emoji: '👍', action: 'added' }]);
  });

  it('clears when tapping the emoji already held', () => {
    expect(reactionPlan([ev(ME, '👍')], ME, '👍')).toEqual([
      { emoji: '👍', action: 'removed' },
    ]);
  });

  it('removes the old before adding the new, so a peer never shows the user twice', () => {
    expect(reactionPlan([ev(ME, '👍')], ME, '❤️')).toEqual([
      { emoji: '👍', action: 'removed' },
      { emoji: '❤️', action: 'added' },
    ]);
  });

  it("ignores another person's reaction when planning", () => {
    expect(reactionPlan([ev(THEM, '❤️')], ME, '👍')).toEqual([
      { emoji: '👍', action: 'added' },
    ]);
  });
});

describe('groupReactions / mergeReaction', () => {
  it('groups a flat log by the message each event targets', () => {
    const a: ReactionEvent = { ...ev(ME, '👍'), reference: 'msg-a' };
    const b: ReactionEvent = { ...ev(THEM, '❤️'), reference: 'msg-b' };
    const c: ReactionEvent = { ...ev(THIRD, '😮'), reference: 'msg-a' };
    const grouped = groupReactions([a, b, c]);
    expect(grouped.get('msg-a')).toEqual([a, c]);
    expect(grouped.get('msg-b')).toEqual([b]);
  });

  it('appends a streamed event without mutating the previous map', () => {
    const prev = groupReactions([ev(ME, '👍')]);
    const next = mergeReaction(prev, ev(THEM, '❤️'));
    expect(prev.get('msg-1')).toHaveLength(1);
    expect(next.get('msg-1')).toHaveLength(2);
  });

  it('starts a new target list when the message has no reactions yet', () => {
    const next = mergeReaction(new Map(), ev(ME, '👍'));
    expect(next.get('msg-1')).toHaveLength(1);
  });

  it('is idempotent under a duplicate delivery of the same event', () => {
    const dup = ev(ME, '👍');
    const next = mergeReaction(mergeReaction(new Map(), dup), dup);
    expect(summarizeReactions(next.get('msg-1')!, ME)).toEqual([
      { emoji: '👍', count: 1, mine: true },
    ]);
  });
});

describe('applyReactionPlan', () => {
  const ctx = { reference: 'msg-1', senderInboxId: ME, baseNs: 100 };

  it('applies the whole plan on the success path', () => {
    const plan = reactionPlan([], ME, '👍');
    const out = applyReactionPlan([], plan, plan.length, ctx);
    expect(summarizeReactions(out, ME)).toEqual([{ emoji: '👍', count: 1, mine: true }]);
  });

  it('applies nothing when the first send failed', () => {
    const prior = [ev(ME, '👍')];
    const plan = reactionPlan(prior, ME, '❤️');
    expect(summarizeReactions(applyReactionPlan(prior, plan, 0, ctx), ME)).toEqual([
      { emoji: '👍', count: 1, mine: true },
    ]);
  });

  // The bug this exists to pin: a replace sends `removed` then `added`. If the
  // removal lands and the add fails, rolling back the whole tap would show the
  // old emoji the network has already dropped — the tapper and the peer would
  // then disagree about what is on the message.
  it('keeps a landed removal when the add failed, rather than reviving the old pill', () => {
    const prior = [ev(ME, '👍')];
    const plan = reactionPlan(prior, ME, '❤️');
    expect(plan).toHaveLength(2);
    expect(summarizeReactions(applyReactionPlan(prior, plan, 1, ctx), ME)).toEqual([]);
  });

  it('leaves other reactors untouched when a step fails', () => {
    const prior = [ev(THEM, '😂'), ev(ME, '👍')];
    const plan = reactionPlan(prior, ME, '❤️');
    const out = summarizeReactions(applyReactionPlan(prior, plan, 1, ctx), ME);
    expect(out).toEqual([{ emoji: '😂', count: 1, mine: false }]);
  });

  it('orders a replace\'s remove strictly before its add', () => {
    const prior = [ev(ME, '👍')];
    const plan = reactionPlan(prior, ME, '❤️');
    const out = applyReactionPlan(prior, plan, plan.length, ctx);
    const added = out.find((e) => e.action === 'added' && e.emoji === '❤️')!;
    const removed = out.find((e) => e.action === 'removed' && e.emoji === '👍')!;
    expect(removed.sentNs).toBeLessThan(added.sentNs);
  });

  it('does not mutate the prior log', () => {
    const prior = [ev(ME, '👍')];
    const snapshot = [...prior];
    applyReactionPlan(prior, reactionPlan(prior, ME, '❤️'), 2, ctx);
    expect(prior).toEqual(snapshot);
  });
});
