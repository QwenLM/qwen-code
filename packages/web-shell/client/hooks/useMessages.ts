import { useMemo } from 'react';
import { useTranscriptBlocks } from '@qwen-code/webui/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';

export function useMessages(
  t: (key: string, vars?: Record<string, string | number>) => string,
): Message[] {
  const blocks = useTranscriptBlocks();
  return useMemo(
    () =>
      transcriptBlocksToDaemonMessages(blocks, {
        labels: {
          promptCancelled: t('request.cancelled'),
          branchSuccess: (name) => t('branch.success', { name }),
        },
      }),
    [blocks, t],
  );
}
