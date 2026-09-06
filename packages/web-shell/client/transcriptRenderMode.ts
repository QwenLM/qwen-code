import { createContext, useContext } from 'react';

export type TranscriptRenderMode = 'interactive' | 'readonly' | 'document';

const TranscriptRenderModeContext =
  createContext<TranscriptRenderMode>('interactive');
const TranscriptDocumentExpandedContext = createContext(true);

export const TranscriptRenderModeProvider =
  TranscriptRenderModeContext.Provider;
export const TranscriptDocumentExpandedProvider =
  TranscriptDocumentExpandedContext.Provider;

export function useTranscriptRenderMode(): TranscriptRenderMode {
  return useContext(TranscriptRenderModeContext);
}

export function useTranscriptDocumentExpanded(): boolean {
  return useContext(TranscriptDocumentExpandedContext);
}
