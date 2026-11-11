/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowUnifiedTask } from '@qwen-code/core';
import {
  buildWorkflowRunView,
  filterWorkflowAgentsByPhase,
  getWorkflowRailSummary,
} from './workflowPanelSelectors.js';

function makeTask(): WorkflowUnifiedTask {
  return {
    id: 'wf-task',
    type: 'local_workflow',
    status: 'running',
    description: 'Deep research harness',
    startTime: 1_000,
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: 'wf_test',
    workflowName: 'deep-research',
    title: 'Deep Research',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/workflows/wf_test',
    phases: [{ title: 'Scope' }, { title: 'Search' }],
    progress: [
      {
        type: 'workflow_phase',
        index: 1,
        title: 'Scope',
      },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'scope',
        phaseIndex: 1,
        phaseTitle: 'Scope',
        state: 'done',
        agentId: 'agent-scope',
        agentType: 'general-purpose',
        model: 'example-fast',
        prompt: 'Scope the question in full detail',
        journalKey: 'journal-scope',
        promptPreview: 'Scope the question',
        resultPreview: 'five angles',
        outputPath: '/tmp/scope-output.json',
        transcriptPath: '/tmp/scope-transcript.jsonl',
        attemptTranscriptPaths: ['/tmp/scope-transcript.jsonl'],
        tokens: 24_000,
        toolCalls: 1,
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'search:docs',
        phaseIndex: 2,
        phaseTitle: 'Search',
        state: 'start',
        agentId: 'agent-search',
        prompt: 'Search official docs in full detail',
        journalKey: 'journal-search',
        promptPreview: 'Search official docs',
        transcriptPath: '/tmp/search-start.jsonl',
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'search:docs',
        phaseIndex: 2,
        phaseTitle: 'Search',
        state: 'progress',
        tokens: 12_000,
        toolCalls: 2,
        lastToolName: 'Read',
        lastToolSummary: '/repo/search.ts',
        recentToolActivities: ['Glob(**/*.ts)', 'Read(/repo/search.ts)'],
        lastProgressAt: 30_500,
      },
    ],
    logs: ['Question: q'],
    agentCount: 2,
    totalTokens: 36_000,
    totalToolCalls: 3,
    abortController: new AbortController(),
    agentControllers: {},
  };
}

describe('workflowPanelSelectors', () => {
  it('builds phase and agent view models with detail metadata', () => {
    const view = buildWorkflowRunView(makeTask(), 31_000);

    expect(view.name).toBe('Deep Research');
    expect(view.agentDoneCount).toBe(1);
    expect(view.agentCount).toBe(2);
    expect(view.elapsedMs).toBe(30_000);
    expect(view.phases).toMatchObject([
      { title: 'Scope', doneAgents: 1, totalAgents: 1, status: 'done' },
      { title: 'Search', doneAgents: 0, totalAgents: 1, status: 'running' },
    ]);
    expect(view.agents).toMatchObject([
      {
        label: 'scope',
        status: 'done',
        agentId: 'agent-scope',
        agentType: 'general-purpose',
        model: 'example-fast',
        prompt: 'Scope the question in full detail',
        journalKey: 'journal-scope',
        tokens: 24_000,
        toolCalls: 1,
        promptPreview: 'Scope the question',
        outputPath: '/tmp/scope-output.json',
        transcriptPath: '/tmp/scope-transcript.jsonl',
        attemptTranscriptPaths: ['/tmp/scope-transcript.jsonl'],
      },
      {
        label: 'search:docs',
        status: 'running',
        agentId: 'agent-search',
        prompt: 'Search official docs in full detail',
        journalKey: 'journal-search',
        tokens: 12_000,
        toolCalls: 2,
        lastToolName: 'Read',
        lastToolSummary: '/repo/search.ts',
        recentToolActivities: ['Glob(**/*.ts)', 'Read(/repo/search.ts)'],
        lastProgressAt: 30_500,
        promptPreview: 'Search official docs',
        transcriptPath: '/tmp/search-start.jsonl',
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('36000');
  });

  it('filters agents by phase', () => {
    const view = buildWorkflowRunView(makeTask(), 31_000);

    expect(filterWorkflowAgentsByPhase(view, '1').map((a) => a.label)).toEqual([
      'scope',
    ]);
    expect(filterWorkflowAgentsByPhase(view, '2').map((a) => a.label)).toEqual([
      'search:docs',
    ]);
  });

  it('builds rail summary without tokens', () => {
    const summary = getWorkflowRailSummary(makeTask(), 31_000);

    expect(summary).toMatchObject({
      label: 'Deep Research',
      description: 'Deep research harness',
      doneAgents: 1,
      agentCount: 2,
      elapsed: '30s',
    });
    expect(JSON.stringify(summary)).not.toContain('token');
    expect(JSON.stringify(summary)).not.toContain('36000');
  });

  it('freezes elapsed time at the pause transition', () => {
    const task = makeTask();
    task.status = 'paused';
    task.endTime = 12_500;
    task.abortController = undefined;
    task.agentControllers = undefined;

    expect(buildWorkflowRunView(task, 99_000).elapsedMs).toBe(11_500);
    expect(getWorkflowRailSummary(task, 99_000).elapsed).toBe('11s');
  });
});
