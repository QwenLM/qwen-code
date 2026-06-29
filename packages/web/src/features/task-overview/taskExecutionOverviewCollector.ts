import type { WebArtifact } from '../artifacts/artifactTypes';
import type {
  WebTaskCheckResult,
  WebTaskTimelineSummary,
} from '../task-timeline/taskTimelineTypes';
import type { WebTaskExecutionOverview } from './taskExecutionOverviewTypes';

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface OverviewTodoItem {
  content: string;
  status: TodoStatus;
}

interface OverviewNotice {
  severity: 'info' | 'warning' | 'error';
}

export interface CollectTaskExecutionOverviewInput {
  connection: {
    sessionId?: string;
    currentModel?: string;
    currentMode?: string;
    workspaceCwd?: string;
    status: string;
  };
  workspace: {
    workspaceCwd?: string;
    status: string;
  };
  promptStatus: string;
  streamingState: string;
  activeTodoItems: readonly OverviewTodoItem[];
  pendingPermissionCount: number;
  notices: readonly OverviewNotice[];
  timelineSummary: WebTaskTimelineSummary;
  timelineChecks: readonly WebTaskCheckResult[];
  artifacts: readonly WebArtifact[];
}

export function collectTaskExecutionOverview({
  activeTodoItems,
  artifacts,
  connection,
  notices,
  pendingPermissionCount,
  promptStatus,
  streamingState,
  timelineChecks,
  timelineSummary,
  workspace,
}: CollectTaskExecutionOverviewInput): WebTaskExecutionOverview {
  const warningNotices = notices.filter(
    (notice) => notice.severity === 'warning',
  ).length;
  const errorNotices = notices.filter(
    (notice) => notice.severity === 'error',
  ).length;
  const changedArtifacts = getChangedArtifacts(artifacts);

  return {
    status: inferCurrentStatus({
      activeTodoItems,
      connectionStatus: connection.status,
      errorNotices,
      pendingPermissionCount,
      promptStatus,
      streamingState,
      timelineSummary,
      workspaceStatus: workspace.status,
    }),
    session: {
      sessionId: connection.sessionId,
      model: connection.currentModel,
      mode: connection.currentMode,
      cwd: connection.workspaceCwd ?? workspace.workspaceCwd,
    },
    progress: {
      ...getTodoProgress(activeTodoItems),
      timeline: timelineSummary,
    },
    checks: [...timelineChecks].sort(
      (left, right) => right.timestamp - left.timestamp,
    ),
    changedArtifacts,
    repository: getRepositoryStatus(changedArtifacts),
    needsAttention: {
      pendingPermissions: pendingPermissionCount,
      failedTimelineItems: timelineSummary.failed,
      warningNotices,
      errorNotices,
    },
  };
}

function inferCurrentStatus({
  activeTodoItems,
  connectionStatus,
  errorNotices,
  pendingPermissionCount,
  promptStatus,
  streamingState,
  timelineSummary,
  workspaceStatus,
}: {
  activeTodoItems: readonly OverviewTodoItem[];
  connectionStatus: string;
  errorNotices: number;
  pendingPermissionCount: number;
  promptStatus: string;
  streamingState: string;
  timelineSummary: WebTaskTimelineSummary;
  workspaceStatus: string;
}): WebTaskExecutionOverview['status'] {
  if (connectionStatus === 'error' || workspaceStatus === 'error') {
    return {
      label: 'Connection issue',
      detail: 'Daemon or workspace connection needs attention.',
      severity: 'failed',
    };
  }
  if (pendingPermissionCount > 0) {
    return {
      label: 'Waiting for approval',
      detail: `${pendingPermissionCount} permission request${
        pendingPermissionCount === 1 ? '' : 's'
      } pending.`,
      severity: 'blocked',
    };
  }
  if (errorNotices > 0 || timelineSummary.failed > 0) {
    return {
      label: 'Needs attention',
      detail: `${timelineSummary.failed} failed timeline event${
        timelineSummary.failed === 1 ? '' : 's'
      } detected.`,
      severity: 'failed',
    };
  }
  if (
    promptStatus !== 'idle' ||
    streamingState !== 'idle' ||
    timelineSummary.running > 0
  ) {
    return {
      label: 'Running',
      detail: timelineSummary.activeTitle ?? 'Agent is processing the task.',
      severity: 'running',
    };
  }
  if (
    activeTodoItems.length > 0 &&
    activeTodoItems.every((item) => item.status === 'completed')
  ) {
    return {
      label: 'Task complete',
      detail: 'All active todos are completed.',
      severity: 'done',
    };
  }
  return {
    label: 'Idle',
    detail: 'No active task is currently running.',
    severity: 'idle',
  };
}

function getTodoProgress(items: readonly OverviewTodoItem[]) {
  const activeTodo =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending');
  return {
    totalTodos: items.length,
    completedTodos: items.filter((item) => item.status === 'completed').length,
    ...(activeTodo ? { activeTodo: activeTodo.content } : {}),
  };
}

function getChangedArtifacts(artifacts: readonly WebArtifact[]) {
  return artifacts.filter(
    (artifact) =>
      artifact.operation === 'modified' || artifact.operation === 'produced',
  );
}

function getRepositoryStatus(
  changedArtifacts: WebArtifact[],
): WebTaskExecutionOverview['repository'] {
  return {
    changedFiles: changedArtifacts.map((artifact) => artifact.path),
    source: changedArtifacts.length > 0 ? 'transcript_inferred' : 'unavailable',
    detail:
      'Git branch and dirty state require daemon git status support; changed files are inferred from transcript activity.',
  };
}
