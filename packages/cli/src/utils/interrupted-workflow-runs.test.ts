/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { InterruptedWorkflowRun } from '@qwen-code/qwen-code-core/agents/workflow-checkpoint.js';
import type { WorkflowSnapshot } from '@qwen-code/qwen-code-core/agents/workflow-snapshot.js';
import { formatInterruptedWorkflowRunsNotice } from './interrupted-workflow-runs.js';

function run(
  overrides: Partial<WorkflowSnapshot> = {},
  extra: Partial<InterruptedWorkflowRun> = {},
): InterruptedWorkflowRun {
  return {
    snapshot: {
      runId: 'wf_0123abcd',
      meta: { name: 'audit', description: 'Audit the repo' },
      status: 'failed',
      script: 'return 1',
      scriptPath: '/runs/generated/inline/wf_0123abcd.js',
      phases: [],
      agentsDispatched: 7,
      agentsCompleted: 3,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1,
      endTime: 2,
      error: 'interrupted',
      ...overrides,
    },
    hasJournal: true,
    ...extra,
  };
}

describe('formatInterruptedWorkflowRunsNotice', () => {
  it('says nothing when no run was interrupted', () => {
    expect(formatInterruptedWorkflowRunsNotice([])).toBeUndefined();
  });

  it('names the run, how far it got, and the call that resumes it', () => {
    expect(
      formatInterruptedWorkflowRunsNotice([run({ args: { files: ['a'] } })]),
    ).toBe(
      [
        'A workflow run was interrupted when the Qwen Code process running it exited:',
        '  wf_0123abcd · audit · 3/7 agents finished',
        '    resume: Workflow({ scriptPath: "/runs/generated/inline/wf_0123abcd.js", resumeFromRunId: "wf_0123abcd", args: {"files":["a"]} })',
        'Run /workflows to see them.',
      ].join('\n'),
    );
  });

  it('resumes by name in a name-only session, and only when the run has one', () => {
    const named = formatInterruptedWorkflowRunsNotice(
      [run({}, { resumeName: 'audit' })],
      { nameOnly: true },
    );
    expect(named).toContain(
      'resume: Workflow({ name: "audit", resumeFromRunId: "wf_0123abcd" })',
    );

    const unnamed = formatInterruptedWorkflowRunsNotice([run()], {
      nameOnly: true,
    });
    expect(unnamed).not.toContain('resume:');
  });

  it('offers no resume when the journal is gone', () => {
    expect(
      formatInterruptedWorkflowRunsNotice([run({}, { hasJournal: false })]),
    ).not.toContain('resume:');
  });

  // Nothing on this path refuses a resume the way the daemon refuses a
  // history retry, so the note is all that stands between a run whose args
  // its history cannot name and a full re-dispatch with none.
  it.each([
    ['they could not be kept', { argsOmitted: true } as const],
    ['its history cannot say what they were', {}],
  ])('asks for the original args when %s', (_case, fields) => {
    expect(formatInterruptedWorkflowRunsNotice([run(fields)])).toContain(
      'resumeFromRunId: "wf_0123abcd" }) (pass its original args too)',
    );
  });

  it('asks for nothing extra when the run is on record as having had none', () => {
    expect(
      formatInterruptedWorkflowRunsNotice([run({ argsRecorded: true })]),
    ).not.toContain('pass its original args too');
  });

  it('lists the first runs and counts the rest', () => {
    const runs = ['wf_1', 'wf_2', 'wf_3', 'wf_4', 'wf_5'].map((runId) =>
      run({ runId, meta: null, agentsDispatched: 0 }),
    );
    const notice = formatInterruptedWorkflowRunsNotice(runs)!;
    const lines = notice.split('\n');

    expect(lines[0]).toBe(
      '5 workflow runs were interrupted when the Qwen Code process running them exited:',
    );
    expect(lines).toContain('  wf_3');
    expect(notice).not.toContain('wf_4');
    expect(lines).toContain('  …and 2 more.');
  });

  it('strips control characters from a name the script declared', () => {
    const notice = formatInterruptedWorkflowRunsNotice([
      run({ meta: { name: 'audit\u001b[31m', description: 'd' } }),
    ]);
    expect(notice).toContain('  wf_0123abcd · audit · 3/7');
  });
});
