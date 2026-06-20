import { useMemo } from 'react';
import {
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { collectArtifactsFromTranscript } from './artifactCollector';

export function useWebArtifacts() {
  const blocks = useTranscriptBlocks();
  const workspace = useWorkspace();
  const artifacts = useMemo(
    () =>
      collectArtifactsFromTranscript(blocks, {
        workspaceCwd: workspace.workspaceCwd,
      }),
    [blocks, workspace.workspaceCwd],
  );

  return {
    artifacts,
    error: undefined,
    loading: false,
    reload: () => artifacts,
    source: 'transcript' as const,
  };
}
