import { createContext } from 'react';

export type QuoteToComposerAction = (text: string) => void;

/**
 * Inserts a quoted message fragment into the active composer. Provided
 * by each chat surface (main chat, split-view panes) next to its own
 * composer. Read-only and embedded transcripts (WebShellTranscript) do
 * not provide it, which hides the Quote affordance there.
 */
export const QuoteToComposerContext =
  createContext<QuoteToComposerAction | null>(null);
