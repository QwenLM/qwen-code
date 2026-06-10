import { useMemo } from 'react';
import { useTranscriptBlocks } from '@qwen-code/webui/daemon-react-sdk';
import { transcriptBlocksToDaemonMessages } from '../adapters/transcriptToMessages';
import type { Message } from '../adapters/types';
import { useI18n } from '../i18n';

export function useMessages(): Message[] {
  const blocks = useTranscriptBlocks();
  const { t } = useI18n();
  return useMemo(
    () =>
      transcriptBlocksToDaemonMessages(blocks, {
        labels: { promptCancelled: t('request.cancelled') },
      }),
    [blocks, t],
  );
}
