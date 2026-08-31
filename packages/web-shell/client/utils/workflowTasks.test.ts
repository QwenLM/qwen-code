import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionWorkflowTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall } from '../adapters/types';
import { findWorkflowTaskForTool } from './workflowTasks';

function workflowTask(id: string): DaemonSessionWorkflowTaskStatus {
  return {
    kind: 'workflow',
    id,
    label: 'Channel analysis',
    description: 'Analyze channel packages',
    status: 'running',
    startTime: 1_000,
    runtimeMs: 200,
    isBackgrounded: false,
    currentPhase: 'Inspect',
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 0,
    agentsCompleted: 0,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: [],
    pendingApprovalCount: 0,
  };
}

function workflowTool(overrides: Partial<ACPToolCall>): ACPToolCall {
  return {
    callId: 'workflow-call',
    toolName: 'workflow',
    status: 'in_progress',
    ...overrides,
  };
}

describe('findWorkflowTaskForTool', () => {
  const tasks: DaemonSessionTaskWithWorkflowStatus[] = [
    workflowTask('wf_expected'),
    workflowTask('wf_other'),
  ];

  it('matches a live workflow update by its runId payload', () => {
    expect(
      findWorkflowTaskForTool(
        tasks,
        workflowTool({
          subContent:
            '```json\n{"runId":"wf_expected","status":"running"}\n```',
        }),
      )?.id,
    ).toBe('wf_expected');
  });

  it('prefers the parent tool identity before live output arrives', () => {
    const linked = workflowTask('wf_expected');
    linked.toolUseId = 'workflow-call';
    expect(
      findWorkflowTaskForTool(
        [workflowTask('wf_other'), linked],
        workflowTool({ subContent: undefined }),
      )?.id,
    ).toBe('wf_expected');
  });

  it('matches a completed background workflow by its result text', () => {
    expect(
      findWorkflowTaskForTool(
        tasks,
        workflowTool({
          status: 'completed',
          rawOutput:
            'Workflow started in background.\nRun ID: wf_expected\nStatus: running',
        }),
      )?.id,
    ).toBe('wf_expected');
  });

  it('does not guess when the tool contains no run identity', () => {
    expect(
      findWorkflowTaskForTool(
        tasks,
        workflowTool({ subContent: 'Starting agents' }),
      ),
    ).toBeUndefined();
  });
});
