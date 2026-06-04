import { useMemo } from 'react';
import { useTranscriptBlocks } from '@qwen-code/webui/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';

export function useMessages(): Message[] {
  const blocks = useTranscriptBlocks();
  return useMemo(() => transcriptBlocksToDaemonMessages(blocks), [blocks]);
}
