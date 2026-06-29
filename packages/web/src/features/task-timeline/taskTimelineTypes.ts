export type WebTaskTimelineKind =
  | 'prompt'
  | 'todo'
  | 'tool'
  | 'permission'
  | 'status';

export type WebTaskTimelineStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'info';

export type WebTaskTimelinePhase =
  | 'prompt'
  | 'planning'
  | 'editing'
  | 'checking'
  | 'blocked'
  | 'finished'
  | 'other';

export type WebTaskCheckKind =
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'build'
  | 'command';

export type WebTaskCheckStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface WebTaskCheckResult {
  kind: WebTaskCheckKind;
  status: WebTaskCheckStatus;
  timestamp: number;
  command?: string;
  blockId?: string;
  toolCallId?: string;
}

export interface WebTaskTimelineItem {
  id: string;
  kind: WebTaskTimelineKind;
  status: WebTaskTimelineStatus;
  phase: WebTaskTimelinePhase;
  title: string;
  detail?: string;
  timestamp: number;
  blockId?: string;
  toolCallId?: string;
  todoId?: string;
  artifactPaths?: string[];
  checkResult?: WebTaskCheckResult;
}

export interface WebTaskTimelineSummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  activeTitle?: string;
}

export type WebTaskTimelineSource = 'transcript';
