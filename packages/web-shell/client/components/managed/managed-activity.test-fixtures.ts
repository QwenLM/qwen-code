import type { components } from './generated/managed-agent-api';

type Schemas = components['schemas'];
const metrics: Schemas['ManagedActivityMetrics'] = {
  requested: 1,
  admission: { allowed: 1, denied: 0, invalid: 0, unknown: 0 },
  execution: {
    not_started: 0,
    running: 0,
    success: 1,
    error: 0,
    cancelled: 0,
    unknown: 0,
  },
  delivery: { pending: 0, complete: 0, partial: 1, unavailable: 0, unknown: 0 },
};
const zero: Schemas['ManagedActivityMetrics'] = {
  requested: 0,
  admission: { allowed: 0, denied: 0, invalid: 0, unknown: 0 },
  execution: {
    not_started: 0,
    running: 0,
    success: 0,
    error: 0,
    cancelled: 0,
    unknown: 0,
  },
  delivery: { pending: 0, complete: 0, partial: 0, unavailable: 0, unknown: 0 },
};
const header = {
  schemaVersion: 1 as const,
  sessionId: 's1',
  scope: 'self' as const,
  readRevision: '12',
  coverageStartSequence: '3',
  coveredThroughSequence: '20',
  startedAt: 1_700_000_000_000,
  availability: 'partial' as const,
  coverageReasons: ['history_before_collection'],
};
export const activityStatistics: Schemas['ManagedDiagnosticActivityStats'] = {
  ...header,
  statistics: {
    tools: metrics,
    files: metrics,
    fileOperations: { read: metrics, write: zero, edit: zero },
    skills: zero,
    skillLoads: zero,
    extensionCommands: zero,
    toolBuckets: [{ key: 'read_file', name: 'read_file', metrics }],
    skillBuckets: [],
    otherTools: zero,
    otherSkills: zero,
  },
};
export const activityItem: Schemas['ManagedActivityInvocation'] = {
  invocationId: 'a'.repeat(64),
  assistantMessageId: 'assistant-1',
  ordinal: 0,
  toolName: 'read_file',
  functionCallId: 'call-1',
  providerCallId: null,
  executionCallId: 'exec-1',
  taskId: null,
  toolKind: 'builtin',
  serverId: null,
  admission: 'allowed',
  execution: 'success',
  delivery: 'partial',
  capture: 'complete',
  file: { operation: 'read', path: 'docs/说明.md', cwdRelative: '.' },
  skill: null,
  requestSequence: '3',
  requestedAt: 1_700_000_000_000,
};
export const activityPage: Schemas['ManagedDiagnosticActivityPage'] = {
  ...header,
  kind: 'tools',
  items: [activityItem],
  hasMore: false,
  nextCursor: null,
};
