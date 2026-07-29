import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { useTranscriptStore } from '@qwen-code/webui/daemon-react-sdk';

export function useAnimationFrameTranscriptBlocks(): readonly DaemonTranscriptBlock[] {
  const store = useTranscriptStore();
  const subscribe = useCallback(
    (notify: () => void) => {
      let frame: number | null = null;
      const unsubscribe = store.subscribe(() => {
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          notify();
        });
      });
      return () => {
        unsubscribe();
        if (frame !== null) {
          window.cancelAnimationFrame(frame);
        }
      };
    },
    [store],
  );
  const getSnapshot = useCallback(() => store.getSnapshot().blocks, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
