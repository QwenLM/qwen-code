import { useEffect, useRef, useState } from 'react';
import {
  useStreamingState,
  useTranscriptStore,
} from '@qwen-code/webui/daemon-react-sdk';

// Estimate output tokens from the active assistant block's streamed text
// length (chars / 4), mirroring the CLI's LoadingIndicator approach.
export function useStreamingOutputTokens(): number {
  const store = useTranscriptStore();
  const streamingState = useStreamingState();
  const charsRef = useRef(0);
  const [displayTokens, setDisplayTokens] = useState(0);

  const isActive =
    streamingState === 'responding' || streamingState === 'thinking';

  useEffect(() => {
    if (!isActive) {
      charsRef.current = 0;
      setDisplayTokens(0);
      return;
    }
    const update = () => {
      const { blocks } = store.getSnapshot();
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (
          b.kind === 'assistant' &&
          b.streaming &&
          !('parentToolCallId' in b && b.parentToolCallId)
        ) {
          charsRef.current = b.text.length;
          return;
        }
      }
    };
    update();
    setDisplayTokens(Math.round(charsRef.current / 4));
    return store.subscribe(update);
  }, [store, isActive]);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      setDisplayTokens(Math.round(charsRef.current / 4));
    }, 100);
    return () => clearInterval(id);
  }, [isActive]);

  return displayTokens;
}
