import { createContext } from 'react';

export type AskInSideTaskAction = (text: string) => void;

/**
 * Creates a side task and places the quoted message fragment into that
 * task's composer as a quote chip. The user writes the prompt themselves;
 * nothing is sent automatically. Provided by the app shell next to the
 * main session's side-task creator, and `null` while side tasks are
 * unavailable. Surfaces without the context offer no Ask action.
 */
export const AskInSideTaskContext = createContext<AskInSideTaskAction | null>(
  null,
);
