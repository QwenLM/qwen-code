import type {
  ManagedArtifact,
  ManagedToolResult,
} from './managed-tool-result-types';

export const artifact: ManagedArtifact = {
  object: 'agent.artifact',
  id: 'artifact-1',
  session_id: 'session-1',
  result_id: 'result-1',
  revision: 'a'.repeat(64),
  stream_role: 'stdout',
  byte_length: 5,
  sha256: 'a'.repeat(64),
  media_type: 'text/plain',
  availability: 'available',
  created_at: 1,
};

export const result: ManagedToolResult = {
  id: 'result-1',
  session_id: 'session-1',
  turn_id: 'turn-1',
  item_id: 'item-1',
  projection_revision: 1,
  execution_status: 'success',
  capture_status: 'complete',
  delivery_status: 'committed',
  capture_scope: 'process_pipes',
  upstream_truncated: false,
  artifacts: [artifact],
};

export const notStartedResult: ManagedToolResult = {
  ...result,
  execution_status: 'not_started',
  capture_status: null,
  capture_scope: null,
  upstream_truncated: null,
  delivery_status: 'blocked',
  artifacts: [],
};
export const blockedResult: ManagedToolResult = {
  ...result,
  execution_status: 'error',
  capture_status: 'unavailable',
  delivery_status: 'blocked',
  reason_code: 'storage_failed',
  upstream_truncated: null,
  artifacts: [],
};
export const previewOnlyResult: ManagedToolResult = {
  ...result,
  preview: {
    text: 'approved excerpt',
    truncated: true,
    stream_id: 'stdout',
    source_start: 0,
    source_end: 5,
  },
};
