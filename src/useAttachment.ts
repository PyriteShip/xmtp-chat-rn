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

  useEffect(() => {
    setStatus({ state: 'idle' });
    if (digest && autoLoad) void load();
  }, [digest, autoLoad, load]);

  return { status, load };
}
