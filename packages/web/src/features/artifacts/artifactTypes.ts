export type WebArtifactOperation =
  | 'read'
  | 'modified'
  | 'produced'
  | 'referenced'
  | 'unknown';

export type WebArtifactSource =
  | 'transcript_tool'
  | 'file_panel'
  | 'task_rail'
  | 'manual';

export interface WebArtifact {
  id: string;
  path: string;
  operation: WebArtifactOperation;
  source: WebArtifactSource;
  title?: string;
  toolName?: string;
  updatedAt: number;
  readCount?: number;
  writeCount?: number;
  diffAvailable?: boolean;
}
