import type {
  ManagedDiagnosticAgentTrace,
  ManagedDiagnosticResources,
} from './managed-agent-provider';

const envelope = {
  schemaVersion: 1 as const,
  sessionId: 's1',
  readRevision: '12',
  availability: 'available' as const,
  coverageReasons: [],
};

export const diagnosticResources: ManagedDiagnosticResources = {
  ...envelope,
  configCoverage: 'complete',
  historyCoverage: 'complete',
  activeConfigRevision: 1,
  activeOperationPhase: 'active',
  outputTruncated: false,
  skills: [
    {
      name: 'manual-skill',
      description: 'User invocation only',
      kind: 'skill',
      origin: 'base',
      extensionId: null,
      modelInvocable: false,
      userInvocable: true,
    },
  ],
  servers: [
    {
      serverId: 'docs',
      serverRevision: 2,
      origin: 'independent',
      extensionId: null,
      selectionState: 'enabled',
      liveState: 'unknown',
      catalogRevision: 1,
      catalogServerRevision: 1,
      attemptRevision: 2,
      attemptServerRevision: 2,
      lastAttemptState: 'failed',
      lastExecutionState: 'settled',
      releaseState: 'released',
      historical: true,
      discovery: { tools: 'stale', resources: 'unknown', prompts: 'unknown' },
      tools: [{ name: 'find_docs', description: 'Saved discovery' }],
      resources: [],
      prompts: [],
    },
  ],
};

export const diagnosticTrace: ManagedDiagnosticAgentTrace = {
  ...envelope,
  scope: 'direct-invocations',
  items: [
    {
      taskId: 'task-a',
      parentSessionId: 's1',
      childSessionId: 'child-a',
      description: 'Inspect changes',
      state: 'settled',
      runtimeState: null,
      createdAt: 1_700_000_000_000,
      startedAt: null,
      settledAt: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
};
