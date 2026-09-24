/**
 * Send and learn whether the message was published or only stored.
 *
 * When the installed SDK offers both `prepareMessage` and
 * `publishPreparedMessages` (stock `@xmtp/react-native-sdk` 5.7.0 does —
 * `sendWithStatus` below is not part of that SDK's `Dm`; it is kept for a
 * build that offers it instead), the message is prepared first, so it is
 * stored under a known id before anything else can go wrong, and that id is
 * what this resolves with either way. Publishing it is then raced against
 * `XmtpChatConfig.publishTimeoutMs` (`DEFAULT_PUBLISH_TIMEOUT_MS` when unset)
 * rather than awaited unbounded — an unbounded await is what used to let a
 * publish that never settles leave a bubble `pending` forever, with no retry
 * affordance (retry only ever showed for `failed` and stored `unpublished`
 * bubbles). A publish that resolves within the bound is `sent`; the
 * `SyncFailedToWait` (unconfirmed-publish) rejection, or the bound running out
 * first, is `unpublished` — the SDK is still trying, or will on its own next
 * publish, and the stream echo reconciles the bubble by this id. At the bound
 * the publish is not cancelled (the SDK exposes no way to cancel it); it keeps
 * running in the background, and a retry (`republishStored`, keyed by this
 * same id) or that later echo is what settles the bubble. Any other rejection
 * rejects here too, carrying this id as `.messageId` so the caller can key a
 * `failed` bubble by it, exactly as it already does for `sendWithStatus`/
 * `send` errors that happen to carry one.
 *
 * Some SDK builds expose `sendWithStatus` instead, which resolves `queued`
 * when the message is stored but could not be confirmed yet (libxmtp
 * SyncFailedToWait). The SDK publishes it later on its own; the stream echo
 * confirms it. That is `unpublished` here, not a failure. On an SDK with
 * neither pair, `send` is used as before and a resolved send is `sent`.
 *
 * On an SDK with neither `prepareMessage`/`publishPreparedMessages` nor
 * `sendWithStatus`, a plain `send` can reject with that same
 * unconfirmed-publish error. It then rejects here too, and the caller records
 * `failed`: the error carries no message id, so there is nothing to track as
 * `unpublished`. A retry of that bubble sends it again. `republishStored`
 * below, which works on an id the caller already holds, maps the same error
 * to `unpublished`.
 */
import type { MessageDelivery } from './deliveryState';
import { xmtpConfig } from './configure';

interface Sendable {
  send(content: any, opts?: any): Promise<string>;
  sendWithStatus?: (content: any, opts?: any) => Promise<{ id: string; status: 'published' | 'queued' }>;
  prepareMessage?: (content: any, opts?: any) => Promise<string>;
  publishPreparedMessages?: () => Promise<unknown>;
}

interface Preparable {
  prepareMessage: (content: any, opts?: any) => Promise<string>;
  publishPreparedMessages: () => Promise<unknown>;
}

function hasPrepare(dm: Sendable): dm is Sendable & Preparable {
  return typeof dm.prepareMessage === 'function' && typeof dm.publishPreparedMessages === 'function';
}

export interface TrackedSend {
  id: string;
  delivery: Extract<MessageDelivery, 'sent' | 'unpublished'>;
}

/** Default for `XmtpChatConfig.publishTimeoutMs` — see its doc comment. */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 15_000;

function resolvePublishTimeoutMs(): number {
  const configured = xmtpConfig().publishTimeoutMs;
  return configured === undefined ? DEFAULT_PUBLISH_TIMEOUT_MS : configured;
}

export async function sendTracked(dm: Sendable, content: unknown, opts?: unknown): Promise<TrackedSend> {
  if (hasPrepare(dm)) {
    return sendPrepared(dm, content, opts);
  }
  if (typeof dm.sendWithStatus === 'function') {
    const r = opts === undefined ? await dm.sendWithStatus(content) : await dm.sendWithStatus(content, opts);
    return { id: r.id, delivery: r.status === 'queued' ? 'unpublished' : 'sent' };
  }
  const id = opts === undefined ? await dm.send(content) : await dm.send(content, opts);
  return { id, delivery: 'sent' };
}

type PublishRaceOutcome = { kind: 'sent' } | { kind: 'unpublished' } | { kind: 'failed'; err: unknown };

/** Race `publish()` against `timeoutMs`, never cancelling it — see `sendTracked`'s doc comment. */
function racePublish(publish: () => Promise<unknown>, timeoutMs: number): Promise<PublishRaceOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'unpublished' });
    }, timeoutMs);
    publish().then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'sent' });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(isUnconfirmedPublish(err) ? { kind: 'unpublished' } : { kind: 'failed', err });
      },
    );
  });
}

/** Attach the prepared id as `.messageId`, the same shape a caller's `storedMessageId(err)` already reads off a send error. */
function withMessageId(err: unknown, messageId: string): Error & { messageId: string } {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'publish failed';
  const wrapped = new Error(message) as Error & { messageId: string };
  wrapped.name = err instanceof Error ? err.name : wrapped.name;
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  wrapped.messageId = messageId;
  return wrapped;
}

async function sendPrepared(dm: Sendable & Preparable, content: unknown, opts: unknown): Promise<TrackedSend> {
  const id = opts === undefined ? await dm.prepareMessage(content) : await dm.prepareMessage(content, opts);
  const outcome = await racePublish(() => dm.publishPreparedMessages(), resolvePublishTimeoutMs());
  if (outcome.kind === 'failed') throw withMessageId(outcome.err, id);
  return { id, delivery: outcome.kind };
}

// libxmtp stores an outgoing message as Unpublished and marks it Published
// only once a sync reads it back; publishing can fail to confirm that in
// time without the publish itself having failed. That specific case reads as
// "still stored, try again later" rather than a real failure — duck-typed by
// message text (like `messageId` below, no dependency on any SDK's error
// class) so a host on an SDK that never throws it just never matches.
const UNCONFIRMED_PUBLISH = /SyncFailedToWait|Sync failed to wait for intent/;

function isUnconfirmedPublish(err: unknown): boolean {
  const message =
    typeof err === 'string'
      ? err
      : typeof err === 'object' && err !== null
        ? (err as { message?: unknown }).message
        : undefined;
  return typeof message === 'string' && UNCONFIRMED_PUBLISH.test(message);
}

interface PreparedPublishable {
  publishPreparedMessages: () => Promise<unknown>;
}

/**
 * Retry a message the SDK already has stored under its own id (an
 * `unpublished` message, or a failed send whose error carried a string
 * `messageId`) by publishing what the SDK has stored, rather than preparing a
 * new send. The id — and so a later stream echo's reconciliation — never
 * changes. `publishPreparedMessages` publishes every message the SDK holds
 * for this conversation, not only this one; each of the others then
 * reconciles when its own echo arrives. Only call this when the installed SDK
 * offers `publishPreparedMessages`; otherwise the caller falls back to an
 * ordinary re-send of a failed bubble.
 *
 * Outcome mapped the same way `sendTracked` maps `sendWithStatus`'s result:
 * no throw is `sent`, an unconfirmed-publish throw is `unpublished` (still
 * stored, still retryable later), any other throw is `failed` again.
 */
export async function republishStored(
  dm: PreparedPublishable,
): Promise<Extract<MessageDelivery, 'sent' | 'unpublished' | 'failed'>> {
  try {
    await dm.publishPreparedMessages();
    return 'sent';
  } catch (err) {
    return isUnconfirmedPublish(err) ? 'unpublished' : 'failed';
  }
}
