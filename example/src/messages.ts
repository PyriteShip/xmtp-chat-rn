/**
 * This app's concrete chat message type, and the one place its message copy
 * lives.
 *
 * `ChatMessage` is generic over the card registry, so instantiating it once
 * here means a new card type is a single edit in `nudge.ts` rather than a
 * search across every screen. The example widens nothing, so the second type
 * parameter is left at its default.
 */

import type { ChatMessage, MessageDescription } from 'xmtp-chat-rn';
import type { EXAMPLE_CARDS } from './nudge';

export type ExampleChatMessage = ChatMessage<typeof EXAMPLE_CARDS>;

/**
 * Renders a `MessageDescription` — what the package returns for an inbox row —
 * as the line the user reads. The package deliberately emits no strings, so
 * every host writes some version of this; translating it is the host's job.
 */
export function previewText(d: MessageDescription): string {
  switch (d.kind) {
    case 'text':
      return d.text;
    case 'reaction':
      return d.fromMe ? `You reacted ${d.emoji}` : `Reacted ${d.emoji}`;
    // `preview` is the card's own direction-aware line when it has one, and
    // `fallback` is what a client without the codec would show.
    case 'card':
      return d.preview ?? d.fallback;
    case 'none':
      return '';
  }
}

/** The one-line form of a message, used by quotes and the actions sheet. */
export function messageSummary(m: ExampleChatMessage): string {
  return m.kind === 'text' ? m.text : `Nudge: ${m.nudge.note}`;
}
