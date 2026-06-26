import { useMemo } from 'react';
import {
  useStreamingState,
  useTranscriptBlocks,
} from '@qwen-code/webui/daemon-react-sdk';
import type { StreamingRawInput } from '@qwen-code/chat-panel';

/**
 * Host-side scan that produces the chat panel's StreamingRawInput from the
 * daemon transcript. The panel's animation engine (in @qwen-code/chat-panel)
 * interpolates from this; the scan stays here because it reads daemon blocks.
 *
 * CLI-aligned (useGeminiStream.ts): chars accumulate main-agent text_delta
 * (+text.length) and tool args (+JSON.stringify(args).length) since the last
 * user turn; agentTokens = sum of subagent task_execution token counts.
 */
export function useStreamingRawInput(): StreamingRawInput {
  const state = useStreamingState();
  const blocks = useTranscriptBlocks();

  return useMemo((): StreamingRawInput => {
    let chars = 0;
    let agentTokens = 0;
    let isReceiving = false;
    const countedToolIds = new Set<string>();

    let lastUserIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.kind === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    for (let i = lastUserIndex + 1; i < blocks.length; i++) {
      const block = blocks[i]!;

      // Main agent assistant text (not subagent).
      if (block.kind === 'assistant' && !block.parentToolCallId) {
        chars += block.text.length;
        if (block.streaming) {
          isReceiving = true;
        }
      }

      // Tool args + subagent token counts.
      if (block.kind === 'tool' && !block.parentToolCallId) {
        if (block.rawInput !== undefined) {
          try {
            chars += JSON.stringify(block.rawInput).length;
          } catch {
            // Best-effort
          }
        }
        const taskTokens = getTaskExecutionTokenCount(block.rawOutput);
        if (taskTokens !== undefined && !countedToolIds.has(block.toolCallId)) {
          agentTokens += taskTokens;
          countedToolIds.add(block.toolCallId);
        }
      }
    }

    return { state, chars, agentTokens, isReceiving };
  }, [state, blocks]);
}

function getTaskExecutionTokenCount(rawOutput: unknown): number | undefined {
  if (
    typeof rawOutput !== 'object' ||
    rawOutput === null ||
    !('type' in rawOutput) ||
    (rawOutput as { type: unknown }).type !== 'task_execution'
  ) {
    return undefined;
  }
  const obj = rawOutput as Record<string, unknown>;
  const tokenCount = obj['tokenCount'];
  if (typeof tokenCount === 'number' && tokenCount > 0) return tokenCount;
  const summary = obj['executionSummary'];
  if (typeof summary === 'object' && summary !== null) {
    const totalTokens = (summary as Record<string, unknown>)['totalTokens'];
    if (typeof totalTokens === 'number' && totalTokens > 0) return totalTokens;
  }
  return undefined;
}
