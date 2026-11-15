import { createContext } from 'react';

export type AskInSideTaskAction = (text: string) => void;

/**
 * Creates a side task and places the quoted message fragment into that
 * task's composer as a quote chip. The user writes the prompt themselves;
 * nothing is sent automatically. Provided by the main chat surface (the
 * chat subtree, next to the composer's quote provider), and `null` while
 * side tasks are unavailable. Chat panes publish `null` over this context
 * because their session is not plumbed into the creator yet; read-only and
 * embedded transcripts, the managed sessions page and the workspace
 * binding creator never see a provider at all. Surfaces without the context
 * offer no Ask action.
 */
export const AskInSideTaskContext = createContext<AskInSideTaskAction | null>(
  null,
);
