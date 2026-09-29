import type {
  ManagedArtifact,
  ManagedToolResult,
} from './managed-tool-result-types';

export const artifact: ManagedArtifact = {
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
