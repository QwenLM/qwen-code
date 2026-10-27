import { createContext } from 'react';

export type QuoteToComposerAction = (text: string) => void;

/**
 * Inserts a quoted message fragment into the active composer. Provided
 * by each chat surface (main chat, split-view panes) next to its own
 * composer, and `null` while that composer cannot take input (a pending
 * approval or a locked prompt admission). Surfaces that do not provide it
 * offer no Quote action: read-only and embedded transcripts
 * (WebShellTranscript), the managed sessions page and the workspace
 * binding creator.
 */
export const QuoteToComposerContext =
  createContext<QuoteToComposerAction | null>(null);
