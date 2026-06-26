import { useEffect, useRef, useState } from 'react';
import type { StreamingRawInput } from './context';

export interface LoadingMetrics {
  estimatedOutputTokens: number;
  isReceivingContent: boolean;
}

/**
 * Streaming loading-metric animation engine. Pure: takes the host-scanned raw
 * input (streaming state + char/agent-token counts) and interpolates a smooth
 * token estimate on a 100ms loop. The block scan that produces the input stays
 * host-side because it reads the daemon transcript.
 *
 * Animation (CLI-aligned): 100ms interval, gap<70 → +3, 70-200 → +20%, >200 → +50;
 * outputTokens = agentTokens + round(animatedChars / 4); snaps down on reset.
 */
export function useStreamingLoadingMetrics(
  input: StreamingRawInput,
): LoadingMetrics {
  const isActive = input.state !== 'idle';
  const displayRef = useRef(0);
  const prevCharsRef = useRef(0);
  const inputRef = useRef(input);
  inputRef.current = input;

  const [metrics, setMetrics] = useState<LoadingMetrics>({
    estimatedOutputTokens: 0,
    isReceivingContent: false,
  });

  // Snap down immediately on reset (no animation needed for a decrease).
  if (input.chars < prevCharsRef.current) {
    displayRef.current = input.chars;
  }
  prevCharsRef.current = input.chars;

  useEffect(() => {
    if (!isActive) {
      displayRef.current = 0;
      setMetrics({ estimatedOutputTokens: 0, isReceivingContent: false });
      return;
    }

    const id = setInterval(() => {
      const { chars: realValue, agentTokens, isReceiving } = inputRef.current;

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
