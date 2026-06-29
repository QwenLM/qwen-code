import type { WebArtifact } from '../artifacts/artifactTypes';
import type {
  WebTaskCheckResult,
  WebTaskTimelineSummary,
} from '../task-timeline/taskTimelineTypes';

export type WebExecutionSeverity =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'done';

export interface WebRepositoryStatus {
  branch?: string;
  dirty?: boolean;
  changedFiles: string[];
  source: 'unavailable' | 'transcript_inferred';
  detail: string;
}

export interface WebTaskExecutionOverview {
  status: {
    label: string;
    detail?: string;
    severity: WebExecutionSeverity;
  };
  session: {
    sessionId?: string;
    model?: string;
    mode?: string;
    cwd?: string;
  };
  progress: {
    totalTodos: number;
    completedTodos: number;
    activeTodo?: string;
    timeline: WebTaskTimelineSummary;
  };
  checks: WebTaskCheckResult[];
  changedArtifacts: WebArtifact[];
  repository: WebRepositoryStatus;
  needsAttention: {
    pendingPermissions: number;
    failedTimelineItems: number;
    warningNotices: number;
    errorNotices: number;
  };
}
