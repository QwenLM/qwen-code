import { describe, expect, it } from 'vitest';
import type {
  DaemonStatusTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { transcriptBlocksToLocalizedMessages } from './useMessages';

function baseBlock(
  block: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
): DaemonTranscriptBlock {
  return {
    ...block,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as DaemonTranscriptBlock;
}

describe('transcriptBlocksToLocalizedMessages', () => {
  it('uses the same localized labels for externally supplied blocks', () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      vars?.name ? `${key}:${vars.name}` : `localized:${key}`;
    const blocks: DaemonTranscriptBlock[] = [
      baseBlock({ id: 'cancelled', kind: 'prompt_cancelled' }),
      baseBlock({
        id: 'branch',
        kind: 'status',
        text: 'legacy branch text',
        source: 'session_branched',
        data: { displayName: 'review' },
      } as Omit<
        DaemonStatusTranscriptBlock,
        'clientReceivedAt' | 'createdAt' | 'updatedAt'
      >),
      baseBlock({
        id: 'interrupted',
        kind: 'error',
        text: 'terminated',
        errorKind: 'model_stream_interrupted',
      } as Omit<
        DaemonStatusTranscriptBlock,
        'clientReceivedAt' | 'createdAt' | 'updatedAt'
      >),
    ];

    expect(transcriptBlocksToLocalizedMessages(blocks, t)).toMatchObject([
      { content: 'localized:request.cancelled' },
      { content: 'branch.success:review' },
      { content: 'localized:error.modelStreamInterrupted' },
    ]);
  });
});
