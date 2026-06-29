import { useMemo } from 'react';
import {
  useActiveTodoList,
  useConnection,
  usePendingPermissions,
  usePromptStatus,
  useSessionNotices,
  useStreamingState,
  useWorkspace,
} from '@qwen-code/webui/daemon-react-sdk';
import { useWebArtifacts } from '../artifacts/useWebArtifacts';
import { useTaskTimeline } from '../task-timeline/useTaskTimeline';
import { collectTaskExecutionOverview } from './taskExecutionOverviewCollector';

export function useTaskExecutionOverview() {
  const connection = useConnection();
  const workspace = useWorkspace();
  const promptStatus = usePromptStatus();
  const streamingState = useStreamingState();
  const activeTodoList = useActiveTodoList();
  const pendingPermissions = usePendingPermissions();
  const { notices } = useSessionNotices();
  const { artifacts } = useWebArtifacts();
  const { items, summary } = useTaskTimeline();

  return useMemo(
    () =>
      collectTaskExecutionOverview({
        connection,
        workspace,
        promptStatus,
        streamingState,
        activeTodoItems: activeTodoList?.items ?? [],
        pendingPermissionCount: pendingPermissions.length,
        notices,
        timelineSummary: summary,
        timelineChecks: items.flatMap((item) =>
          item.checkResult ? [item.checkResult] : [],
        ),
        artifacts,
      }),
    [
      activeTodoList?.items,
      artifacts,
      connection,
      items,
      notices,
      pendingPermissions.length,
      promptStatus,
      streamingState,
      summary,
      workspace,
    ],
  );
}
