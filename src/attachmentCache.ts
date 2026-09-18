/**
 * Leaf module for the decrypted-attachment cache — keyed by contentDigest +
 * secret (see `openCacheKey`) and holding in-flight/resolved
 * `DecryptedLocalAttachment` promises.
 *
 * Split out of `attachments.ts` so `client.ts` can import `clearAttachmentCache`
 * statically, without a require cycle: `attachments.ts` already has a static
 * import of `getActiveXmtpClient` FROM `client.ts`, so a static import back
 * from `client.ts` to `attachments.ts` would be a real cycle between the two.
 * This module imports from neither, so both import it statically instead —
 * no lazy `require`, no try/catch standing in for a type system that would
 * otherwise catch a rename.
 */
import type { DecryptedLocalAttachment, RemoteAttachmentContent } from '@xmtp/react-native-sdk';

export const opened = new Map<string, Promise<DecryptedLocalAttachment>>();

// contentDigest is the SHA-256 of the CIPHERTEXT, not the plaintext, and each
// file is encrypted with a fresh random secret — so identical plaintext
// produces different digests, and two legitimately-encrypted contents never
// collide on digest alone. The case this composite key actually guards
// against is adversarial: a sender-crafted message that reuses another
// file's contentDigest with a different secret. Keying on digest alone would
// let that message serve back the OTHER file's already-decrypted bytes
// instead of downloading and decrypting its own. `secret` is unique per
// encryption, so the pair (digest, secret) is a safe key.
// Exported (not part of the package's public `index.ts` surface) so
// `useAttachment.ts` can key its own reload effect and recycled-cell guard
// identically to this module's cache, rather than re-deriving the same
// composite key and risking the two definitions drifting apart.
export function openCacheKey(content: Pick<RemoteAttachmentContent, 'contentDigest' | 'secret'>): string {
  return `${content.contentDigest}:${content.secret}`;
}

/**
 * Drop every decrypted-file entry (downloaded or sender-primed). Called from
 * `client.ts`'s teardown (`dropXmtpClient` / `resetXmtpLocalState`) so a
 * decrypted file from the wallet that just signed out — or whose local state
 * was just wiped — is not still reachable in memory after switching identity.
 * Also the test seam that resets state between tests.
 */
export function clearAttachmentCache(): void {
  opened.clear();
}
