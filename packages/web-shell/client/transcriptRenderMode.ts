import { createContext, useContext } from 'react';

export type TranscriptRenderMode = 'interactive' | 'readonly' | 'document';

const TranscriptRenderModeContext =
  createContext<TranscriptRenderMode>('interactive');

export const TranscriptRenderModeProvider =
  TranscriptRenderModeContext.Provider;

export function useTranscriptRenderMode(): TranscriptRenderMode {
  return useContext(TranscriptRenderModeContext);
}
