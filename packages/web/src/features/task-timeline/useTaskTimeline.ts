import { useMemo } from 'react';
import {
  useActiveTodoList,
  usePendingPermissions,
  useTranscriptBlocks,
} from '@qwen-code/webui/daemon-react-sdk';
import {
  collectTaskTimelineFromTranscript,
  summarizeTaskTimeline,
} from './taskTimelineCollector';

export function useTaskTimeline() {
  const blocks = useTranscriptBlocks();
  const activeTodoList = useActiveTodoList();
  const pendingPermissions = usePendingPermissions();

  const items = useMemo(
    () => collectTaskTimelineFromTranscript(blocks),
    [blocks],
  );
  const activeTodo = activeTodoList?.items.find(
    (item) => item.status === 'in_progress' || item.status === 'pending',
  );
  const pendingPermissionCount = pendingPermissions.length;
  const pendingPermissionTitle = pendingPermissions[0]?.title;
  const activeTodoTitle = activeTodo?.content;

  const summary = useMemo(() => {
    const base = summarizeTaskTimeline(items);
    return {
      ...base,
      blocked: Math.max(base.blocked, pendingPermissionCount),
      activeTitle:
        base.activeTitle ?? activeTodoTitle ?? pendingPermissionTitle,
    };
  }, [activeTodoTitle, items, pendingPermissionCount, pendingPermissionTitle]);

  return {
    items,
    summary,
    error: undefined,
    loading: false,
    reload: () => items,
    source: 'transcript' as const,
  };
}
