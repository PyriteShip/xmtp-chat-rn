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
import { openAttachment, openCacheKey } from './attachments';

// Never equal to a real key (string) or "no content" (undefined) — forces
// the mount's first effect run to see a "changed" key so it loads.
const UNSET = Symbol('useAttachment-unset-key');

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
  // Keyed the same way the package cache is (attachments.ts's openCacheKey:
  // contentDigest + secret), not on contentDigest alone. A digest-only key
  // would treat two contents that share a digest but carry different secrets
  // as "the same file" — the exact case a sender-crafted message reusing
  // another file's digest could trigger — and this hook would then neither
  // reload for the switch nor reject that content's stale in-flight result.
  const key = content ? openCacheKey(content) : undefined;

  const load = useCallback(async () => {
    const target = contentRef.current;
    if (!target) return;
    const targetKey = openCacheKey(target);
    // A recycled list cell can switch content mid-download; only the file the
    // cell still shows may land in its state.
    const current = () => {
      const c = contentRef.current;
      return !!c && openCacheKey(c) === targetKey;
    };
    setStatus({ state: 'loading' });
    try {
      const file = await openAttachment(target);
      if (current()) setStatus({ state: 'ready', file });
    } catch (err: any) {
      if (current()) setStatus({ state: 'failed', error: err?.message ?? String(err) });
    }
  }, []);

  // This effect re-runs for two different reasons, which must not be
  // conflated: a genuinely new file (key changed, including to/from
  // undefined) resets the bubble and loads it if autoLoad is on. A bare
  // autoLoad flip is not a new file — it must never wipe an already-loaded,
  // in-flight, or failed bubble back to idle. It only starts a load when the
  // bubble was still idle at the moment autoLoad turned on (e.g. autoLoad
  // turning on for a bubble that had been waiting for a tap).
  const prevKeyRef = useRef<string | undefined | typeof UNSET>(UNSET);
  const prevAutoLoadRef = useRef(autoLoad);
  useEffect(() => {
    const keyChanged = prevKeyRef.current !== key;
    const autoLoadTurnedOn = !prevAutoLoadRef.current && autoLoad;
    prevKeyRef.current = key;
    prevAutoLoadRef.current = autoLoad;

    if (keyChanged) {
      setStatus({ state: 'idle' });
      if (key && autoLoad) void load();
      return;
    }
    if (autoLoadTurnedOn && key && status.state === 'idle') {
      void load();
    }
  }, [key, autoLoad, load]);

  return { status, load };
}
