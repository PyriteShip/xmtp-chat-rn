/**
 * Pure reaction bookkeeping for the chat thread (Signal's model).
 *
 * Reactions arrive as their own XMTP messages referencing a target message id,
 * each an `added` or `removed` event. This module folds a target's event log
 * into the per-emoji pills the bubble renders, and decides which events a tap
 * on an emoji must send.
 *
 * **One reaction per person per message** — Signal's rule, not Slack's. Picking
 * a different emoji replaces yours rather than stacking a second pill, so a
 * reacting party is represented exactly once under a bubble and the pill row
 * stays a legible tally instead of a scoreboard. The latest event a sender
 * emitted is therefore the whole of their state: a later `added` supersedes an
 * earlier one on a different emoji, and a `removed` clears them.
 *
 * Kept free of XMTP and React so the fold is unit-testable on plain objects.
 */

/** One reaction message, normalized off the wire. */
export interface ReactionEvent {
  /** Message id of the bubble being reacted to. */
  reference: string;
  /** Inbox id of whoever reacted — the identity a reaction is deduped by. */
  senderInboxId: string;
  /** The emoji itself (unicode schema). */
  emoji: string;
  action: 'added' | 'removed';
  /** Send time; orders the fold, so a stale event can't win. */
  sentNs: number;
}

/** One pill under a bubble: an emoji, how many reacted with it, and whether you did. */
export interface ReactionSummary {
  emoji: string;
  count: number;
  /** True when the signed-in user is one of the reactors — drives the filled pill. */
  mine: boolean;
}

/**
 * Signal's quick-reaction row. Six slots, ordered as Signal orders them, so the
 * bar stays a muscle-memory target rather than a menu to read.
 */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '😮', '😢'] as const;

/** One chronological replay of a target's log — the basis of every read below. */
interface Replay {
  /** Each sender's live emoji (absent once they've cleared it). */
  live: Map<string, string>;
  /** When each emoji was first taken up, which fixes the pill row's order. */
  firstSeen: Map<string, number>;
}

/**
 * Walk a target's events in send order. Both outputs fall out of the same pass:
 * who holds what now, and the order the emoji first appeared.
 */
function replay(events: readonly ReactionEvent[]): Replay {
  // Latest event per sender wins, so replay in send order and let each
  // overwrite. Sorting a copy keeps the caller's array untouched.
  const ordered = [...events].sort((a, b) => a.sentNs - b.sentNs);
  const live = new Map<string, string>();
  const firstSeen = new Map<string, number>();
  for (const e of ordered) {
    if (e.action === 'added') {
      live.set(e.senderInboxId, e.emoji);
      if (!firstSeen.has(e.emoji)) firstSeen.set(e.emoji, e.sentNs);
    }
    // A `removed` only clears when it names the emoji the sender currently
    // holds — a late-arriving removal of an emoji they've already replaced
    // must not wipe the replacement.
    else if (live.get(e.senderInboxId) === e.emoji) live.delete(e.senderInboxId);
  }
  return { live, firstSeen };
}

/**
 * Fold a single target's events into its pills, ordered by when each emoji was
 * first taken up so the row doesn't reshuffle as counts change.
 */
export function summarizeReactions(
  events: readonly ReactionEvent[],
  myInboxId: string | null,
): ReactionSummary[] {
  const { live, firstSeen } = replay(events);
  if (live.size === 0) return [];
  const counts = new Map<string, ReactionSummary>();
  for (const [sender, emoji] of live) {
    const entry = counts.get(emoji) ?? { emoji, count: 0, mine: false };
    entry.count += 1;
    if (myInboxId && sender === myInboxId) entry.mine = true;
    counts.set(emoji, entry);
  }
  return [...counts.values()].sort(
    (a, b) => (firstSeen.get(a.emoji) ?? 0) - (firstSeen.get(b.emoji) ?? 0),
  );
}

/** Which emoji the signed-in user currently holds on a target, or null. */
export function myReaction(
  events: readonly ReactionEvent[],
  myInboxId: string | null,
): string | null {
  if (!myInboxId) return null;
  return replay(events).live.get(myInboxId) ?? null;
}

/**
 * The reaction messages a tap on `emoji` must send, in order.
 *
 * Tapping the emoji you already hold clears it (one `removed`). Tapping a
 * different one replaces yours: the old is removed first so a peer that
 * replays the events in order never briefly shows you twice.
 */
export function reactionPlan(
  events: readonly ReactionEvent[],
  myInboxId: string | null,
  emoji: string,
): ReactionStep[] {
  const mine = myReaction(events, myInboxId);
  if (mine === emoji) return [{ emoji, action: 'removed' }];
  const plan: ReactionStep[] = [];
  if (mine) plan.push({ emoji: mine, action: 'removed' });
  plan.push({ emoji, action: 'added' });
  return plan;
}

/** One step of a `reactionPlan`. */
export type ReactionStep = { emoji: string; action: 'added' | 'removed' };

/**
 * The events a target should hold after a toggle attempt, given how many of the
 * plan's steps actually reached the network.
 *
 * A replace sends two messages, so a failure can land the `removed` and lose the
 * `added`. Reverting the whole tap would then show a pill the network no longer
 * has — the tapper sees their old emoji, the peer sees none. Keeping exactly the
 * steps that landed is what keeps the two views agreeing.
 *
 * `applied === plan.length` is the success path (and the optimistic one, applied
 * before any send), so both callers share this single construction.
 */
export function applyReactionPlan(
  before: readonly ReactionEvent[],
  plan: readonly ReactionStep[],
  applied: number,
  ctx: { reference: string; senderInboxId: string; baseNs: number },
): ReactionEvent[] {
  return [
    ...before,
    ...plan.slice(0, Math.max(0, applied)).map((step, i) => ({
      reference: ctx.reference,
      senderInboxId: ctx.senderInboxId,
      emoji: step.emoji,
      action: step.action,
      // +i keeps a replace's remove strictly before its add, so the fold
      // cannot resolve the pair in the wrong order.
      sentNs: ctx.baseNs + i,
    })),
  ];
}

/** Group a flat event list by the message each one targets. */
export function groupReactions(
  events: readonly ReactionEvent[],
): Map<string, ReactionEvent[]> {
  const byTarget = new Map<string, ReactionEvent[]>();
  for (const e of events) {
    const list = byTarget.get(e.reference);
    if (list) list.push(e);
    else byTarget.set(e.reference, [e]);
  }
  return byTarget;
}

/**
 * Merge a newly-streamed event into an existing per-target map, returning a new
 * map (the hook holds this in state). Duplicate deliveries of the same event
 * are idempotent — the fold is order-independent per sender, and a repeat of an
 * event already applied changes nothing.
 */
export function mergeReaction(
  prev: ReadonlyMap<string, ReactionEvent[]>,
  next: ReactionEvent,
): Map<string, ReactionEvent[]> {
  const merged = new Map(prev);
  const list = merged.get(next.reference) ?? [];
  merged.set(next.reference, [...list, next]);
  return merged;
}
