/**
 * Load state for one attachment bubble.
 *
 * Downloads and decrypts on mount by default. Pass `autoLoad: false` for types
 * a user should opt into (video, large documents) and call `load()` from a tap.
 * `load()` is also the retry after a failure. Results are cached per file for
 * the session (see attachments.ts), so a bubble scrolling back into view does
 * not download again.
 *
 * Our own local copy has no `attachment` until its upload finishes; render
 * `message.localFile` for it instead of calling this with undefined.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecryptedLocalAttachment, RemoteAttachmentContent } from '@xmtp/react-native-sdk';
import { openAttachment } from './attachments';

// Never equal to a real digest (string) or "no content" (undefined) — forces
// the mount's first effect run to see a "changed" digest so it loads.
const UNSET = Symbol('useAttachment-unset-digest');

export type AttachmentLoadState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; file: DecryptedLocalAttachment }
  | { state: 'failed'; error: string };

export function useAttachment(
  content: RemoteAttachmentContent | undefined,
  opts: { autoLoad?: boolean } = {},
): { status: AttachmentLoadState; load: () => Promise<void> } {
  const autoLoad = opts.autoLoad ?? true;
  const [status, setStatus] = useState<AttachmentLoadState>({ state: 'idle' });
  const contentRef = useRef(content);
  contentRef.current = content;
  const digest = content?.contentDigest;

  const load = useCallback(async () => {
    const target = contentRef.current;
    if (!target) return;
    // A recycled list cell can switch content mid-download; only the file the
    // cell still shows may land in its state.
    const current = () => contentRef.current?.contentDigest === target.contentDigest;
    setStatus({ state: 'loading' });
    try {
      const file = await openAttachment(target);
      if (current()) setStatus({ state: 'ready', file });
    } catch (err: any) {
      if (current()) setStatus({ state: 'failed', error: err?.message ?? String(err) });
    }
  }, []);

  // This effect re-runs for two different reasons, which must not be
  // conflated: a genuinely new file (digest changed, including to/from
  // undefined) resets the bubble and loads it if autoLoad is on. A bare
  // autoLoad flip is not a new file — it must never wipe an already-loaded,
  // in-flight, or failed bubble back to idle. It only starts a load when the
  // bubble was still idle at the moment autoLoad turned on (e.g. autoLoad
  // turning on for a bubble that had been waiting for a tap).
  const prevDigestRef = useRef<string | undefined | typeof UNSET>(UNSET);
  const prevAutoLoadRef = useRef(autoLoad);
  useEffect(() => {
    const digestChanged = prevDigestRef.current !== digest;
    const autoLoadTurnedOn = !prevAutoLoadRef.current && autoLoad;
    prevDigestRef.current = digest;
    prevAutoLoadRef.current = autoLoad;

    if (digestChanged) {
      setStatus({ state: 'idle' });
      if (digest && autoLoad) void load();
      return;
    }
    if (autoLoadTurnedOn && digest && status.state === 'idle') {
      void load();
    }
  }, [digest, autoLoad, load]);

  return { status, load };
}
