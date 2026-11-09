import type {
  ManagedDiagnosticAgentTrace,
  ManagedDiagnosticContextUsage,
  ManagedDiagnosticResources,
  ManagedDiagnosticStats,
} from './managed-agent-provider';

const envelope = {
  schemaVersion: 1 as const,
  sessionId: 's1',
  readRevision: '12',
  availability: 'available' as const,
  coverageReasons: [],
};

export const diagnosticContext: ManagedDiagnosticContextUsage = {
  ...envelope,
  sourceSequence: '10',
  stale: false,
  staleReasons: [],
  estimated: true,
  context: {
    version: 1,
    attemptId: 'attempt',
    turnId: 'turn',
    model: 'model-a',
    observedAt: 1_700_000_000_000,
    inputTokens: null,
    cachedTokens: null,
    contextWindowSize: 32_000,
    breakdown: {
      systemPrompt: 100,
      builtinTools: 20,
      mcpTools: 10,
      instructionFiles: 30,
      memoryFiles: 0,
      skills: 5,
      startupContext: 0,
      messages: 200,
    },
    thresholds: null,
    details: [],
    attributionComplete: true,
    detailsTruncated: false,
  },
};

const bucket = {
  requests: { total: 1, success: 1, error: 0, cancelled: 0, interrupted: 0 },
  tokens: { prompt: 100, candidates: 10, total: 110, cached: 20, thoughts: 0 },
  usageKnown: { prompt: 1, candidates: 1, total: 1, cached: 1, thoughts: 0 },
  latencyMs: 1_000,
  timing: {
    ttftCount: 1,
    totalTtftMs: 100,
    generationCount: 1,
    totalGenerationMs: 900,
    throughputOutputTokens: 10,
  },
  failures: { http: 0, transport: 0, timeout: 0, other: 0 },
  backoffRetries: 0,
};

const emptyBucket = {
  requests: { total: 0, success: 0, error: 0, cancelled: 0, interrupted: 0 },
  tokens: { prompt: 0, candidates: 0, total: 0, cached: 0, thoughts: 0 },
  usageKnown: { prompt: 0, candidates: 0, total: 0, cached: 0, thoughts: 0 },
  latencyMs: 0,
  timing: {
    ttftCount: 0,
    totalTtftMs: 0,
    generationCount: 0,
    totalGenerationMs: 0,
    throughputOutputTokens: 0,
  },
  failures: { http: 0, transport: 0, timeout: 0, other: 0 },
  backoffRetries: 0,
};

export const diagnosticStats: ManagedDiagnosticStats = {
  ...envelope,
  sourceSequence: '11',
  statistics: {
    version: 1,
    snapshotRevision: 1,
    observedAt: 1_700_000_000_000,
    coverage: { gaps: [] },
    totals: bucket,
    sources: { main: bucket, hook: emptyBucket, compression: emptyBucket },
    models: [
      {
        key: 'a'.repeat(64),
        name: 'model-a',
        nameTruncated: false,
        metrics: bucket,
      },
    ],
    overflow: emptyBucket,
    recent: [],
    modelBreakdownOmitted: false,
    samplesTruncated: false,
  },
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
