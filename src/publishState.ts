/**
 * Send and learn whether the message was published or only stored.
 *
 * Some SDK builds expose `sendWithStatus`, which resolves `queued` when the
 * message is stored but could not be confirmed yet (libxmtp SyncFailedToWait).
 * The SDK publishes it later on its own; the stream echo confirms it. That is
 * `unpublished` here, not a failure. On an SDK without it, `send` is used as
 * before and a resolved send is `sent`.
 *
 * On such an SDK a plain `send` can reject with that same unconfirmed-publish
 * error. It then rejects here too, and the caller records `failed`: the error
 * carries no message id, so there is nothing to track as `unpublished`. A
 * retry of that bubble sends it again. `republishStored` below, which works
 * on an id the caller already holds, maps the same error to `unpublished`.
 */
import type { MessageDelivery } from './deliveryState';

interface Sendable {
  send(content: any, opts?: any): Promise<string>;
  sendWithStatus?: (content: any, opts?: any) => Promise<{ id: string; status: 'published' | 'queued' }>;
}

export interface TrackedSend {
  id: string;
  delivery: Extract<MessageDelivery, 'sent' | 'unpublished'>;
}

export async function sendTracked(dm: Sendable, content: unknown, opts?: unknown): Promise<TrackedSend> {
  if (typeof dm.sendWithStatus === 'function') {
    const r = opts === undefined ? await dm.sendWithStatus(content) : await dm.sendWithStatus(content, opts);
    return { id: r.id, delivery: r.status === 'queued' ? 'unpublished' : 'sent' };
  }
  const id = opts === undefined ? await dm.send(content) : await dm.send(content, opts);
  return { id, delivery: 'sent' };
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
