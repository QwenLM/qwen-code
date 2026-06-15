import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStreamingState,
  useTranscriptBlocks,
} from '@qwen-code/webui/daemon-react-sdk';

interface LoadingMetrics {
  estimatedOutputTokens: number;
  isReceivingContent: boolean;
}

interface BlocksScan {
  chars: number;
  agentTokens: number;
  isReceiving: boolean;
}

/**
 * CLI-aligned streaming loading metrics derived from transcript blocks.
 *
 * CLI source (useGeminiStream.ts + LoadingIndicator.tsx):
 * - streamingChars: accumulated from text_delta (+text.length) and
 *   ToolCallRequest (+JSON.stringify(args).length). Reset only on new
 *   user queries, NOT on tool-result continuations.
 * - isReceivingContent: false at submitQuery start, true on first
 *   content event. Never changed elsewhere (tool calls don't flip it).
 * - outputTokens = agentTokens + round(animatedChars / 4)
 *   where agentTokens = sum of subagent task_execution.tokenCount
 * - Animation: 100ms interval, gap<70→+3, 70-200→+20%, >200→+50
 */
export function useStreamingLoadingMetrics(): LoadingMetrics {
  const streamingState = useStreamingState();
  const blocks = useTranscriptBlocks();
  const isActive = streamingState !== 'idle';

  const displayRef = useRef(0);
  const prevCharsRef = useRef(0);

  const [metrics, setMetrics] = useState<LoadingMetrics>({
    estimatedOutputTokens: 0,
    isReceivingContent: false,
  });

  // Derive metrics from transcript blocks via useMemo (avoids O(n) work in render body).
  const scan = useMemo((): BlocksScan => {
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

      // Tool args (like CLI's ToolCallRequest → JSON.stringify(args).length).
      // Also extract subagent tokenCount (like CLI's Composer agentTokens).
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

    return { chars, agentTokens, isReceiving };
  }, [blocks]);

  // Sync refs from memoized scan results.
  const scanRef = useRef(scan);
  scanRef.current = scan;

  // Snap down immediately on reset (no animation needed for decrease).
  if (scan.chars < prevCharsRef.current) {
    displayRef.current = scan.chars;
  }
  prevCharsRef.current = scan.chars;

  // Animation loop: 100ms interval, smooth interpolation.
  useEffect(() => {
    if (!isActive) {
      displayRef.current = 0;
      setMetrics({ estimatedOutputTokens: 0, isReceivingContent: false });
      return;
    }

    const id = setInterval(() => {
      const { chars: realValue, agentTokens, isReceiving } = scanRef.current;

      // Snap down on reset.
      if (realValue < displayRef.current) {
        displayRef.current = realValue;
        setMetrics({
          estimatedOutputTokens: agentTokens + Math.round(realValue / 4),
          isReceivingContent: isReceiving,
        });
        return;
      }

      const gap = realValue - displayRef.current;
      if (gap <= 0) {
        // No char movement, but sync agentTokens and isReceivingContent.
        setMetrics((prev) => {
          const next = {
            estimatedOutputTokens:
              agentTokens + Math.round(displayRef.current / 4),
            isReceivingContent: isReceiving,
          };
          if (
            prev.estimatedOutputTokens === next.estimatedOutputTokens &&
            prev.isReceivingContent === next.isReceivingContent
          ) {
            return prev;
          }
          return next;
        });
        return;
      }

      // Smooth interpolation: small gaps crawl, large gaps leap.
      let increment: number;
      if (gap < 70) {
        increment = 3;
      } else if (gap <= 200) {
        increment = Math.max(3, Math.round(gap * 0.2));
      } else {
        increment = 50;
      }

      const next = Math.min(displayRef.current + increment, realValue);
      displayRef.current = next;

      setMetrics({
        estimatedOutputTokens: agentTokens + Math.round(next / 4),
        isReceivingContent: isReceiving,
      });
    }, 100);

    return () => clearInterval(id);
  }, [isActive]);

  return metrics;
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
