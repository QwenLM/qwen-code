import { describe, expect, it } from 'vitest';
import type { WebArtifact } from '../artifacts/artifactTypes';
import { collectTaskExecutionOverview } from './taskExecutionOverviewCollector';

const baseSummary = {
  total: 0,
  running: 0,
  completed: 0,
  failed: 0,
  blocked: 0,
};

function collect(
  overrides: Partial<Parameters<typeof collectTaskExecutionOverview>[0]> = {},
) {
  return collectTaskExecutionOverview({
    connection: { status: 'connected' },
    workspace: { status: 'ready' },
    promptStatus: 'idle',
    streamingState: 'idle',
    activeTodoItems: [],
    pendingPermissionCount: 0,
    notices: [],
    timelineSummary: baseSummary,
    timelineChecks: [],
    artifacts: [],
    ...overrides,
  });
}

describe('collectTaskExecutionOverview', () => {
  it('prioritizes pending permissions over running state', () => {
    const overview = collect({
      pendingPermissionCount: 2,
      promptStatus: 'streaming',
    });

    expect(overview.status).toEqual({
      label: 'Waiting for approval',
      detail: '2 permission requests pending.',
      severity: 'blocked',
    });
    expect(overview.needsAttention.pendingPermissions).toBe(2);
  });

  it('summarizes todos, checks, notices, and changed artifacts', () => {
    const artifacts: WebArtifact[] = [
      {
        id: 'read',
        path: 'README.md',
        operation: 'read',
        source: 'transcript_tool',
        updatedAt: 1,
      },
      {
        id: 'edit',
        path: 'src/App.tsx',
        operation: 'modified',
        source: 'transcript_tool',
        updatedAt: 2,
      },
    ];
    const overview = collect({
      activeTodoItems: [
        { content: 'Done', status: 'completed' },
        { content: 'Next', status: 'pending' },
      ],
      notices: [{ severity: 'warning' }, { severity: 'error' }],
      timelineSummary: { ...baseSummary, failed: 1 },
      timelineChecks: [
        {
          kind: 'test',
          status: 'passed',
          timestamp: 10,
          command: 'npm test',
        },
        {
          kind: 'lint',
          status: 'failed',
          timestamp: 20,
          command: 'npm run lint',
        },
      ],
      artifacts,
    });

    expect(overview.progress).toEqual({
      totalTodos: 2,
      completedTodos: 1,
      activeTodo: 'Next',
      timeline: { ...baseSummary, failed: 1 },
    });
    expect(overview.checks.map((check) => check.kind)).toEqual([
      'lint',
      'test',
    ]);
    expect(overview.changedArtifacts.map((artifact) => artifact.path)).toEqual([
      'src/App.tsx',
    ]);
    expect(overview.repository.changedFiles).toEqual(['src/App.tsx']);
    expect(overview.needsAttention).toEqual({
      pendingPermissions: 0,
      failedTimelineItems: 1,
      warningNotices: 1,
      errorNotices: 1,
    });
  });
});
