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

export interface WebTaskTimelineItem {
  id: string;
  kind: WebTaskTimelineKind;
  status: WebTaskTimelineStatus;
  title: string;
  detail?: string;
  timestamp: number;
  blockId?: string;
  toolCallId?: string;
  todoId?: string;
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
