import { describe, expect, it } from 'vitest';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { getTranslator } from '../i18n';
import {
  buildTaskExplainQuestion,
  explainDisplayLabel,
  getComposerTaskChipGroups,
  isComposerTask,
} from './composerTasks';

const base = {
  id: 'task-1',
  label: 'task',
  description: 'task',
  status: 'running' as const,
  startTime: 0,
  runtimeMs: 0,
};

describe('isComposerTask', () => {
  it('shows non-agent tasks and excludes agents', () => {
    const tasks: Array<[DaemonSessionTaskWithWorkflowStatus, boolean]> = [
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: false,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: true,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'shell',
          command: 'npm test',
          cwd: '/workspace',
        },
        true,
      ],
      [
        {
          ...base,
          kind: 'monitor',
          command: 'watch logs',
          eventCount: 0,
          lastEventTime: 0,
          droppedLines: 0,
        },
        true,
      ],
      [
        {
          ...base,
          kind: 'workflow',
          isBackgrounded: true,
          currentPhase: null,
          phaseVisits: [],
          dispatches: [],
          agentsDispatched: 0,
          agentsCompleted: 0,
          tokensSpent: 0,
          tokenBudgetTotal: null,
          recentLogs: [],
          pendingApprovalCount: 0,
        },
        true,
      ],
    ];

    for (const [task, expected] of tasks) {
      expect(isComposerTask(task)).toBe(expected);
    }
  });

  it('excludes retained workflow history', () => {
    // getWorkflowTasks() merges the project's saved runs into the same
    // list. Counting them would present the whole retained history as this
    // session's background work.
    const historical: DaemonSessionTaskWithWorkflowStatus = {
      ...base,
      status: 'completed',
      kind: 'workflow',
      isHistorical: true,
      isBackgrounded: false,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    };
    expect(isComposerTask(historical)).toBe(false);
    expect(isComposerTask({ ...historical, isHistorical: false })).toBe(true);
  });
});

describe('getComposerTaskChipGroups', () => {
  type Status = DaemonSessionTaskWithWorkflowStatus['status'];
  const agent = (
    id: string,
    status: Status,
    isBackgrounded = true,
  ): DaemonSessionTaskWithWorkflowStatus =>
    ({
      ...base,
      id,
      kind: 'agent',
      status,
      isBackgrounded,
      subagentType: 'general-purpose',
    }) as DaemonSessionTaskWithWorkflowStatus;
  const shell = (id: string, status: Status) =>
    ({
      ...base,
      id,
      kind: 'shell',
      status,
      command: 'npm test',
      cwd: '/workspace',
    }) as DaemonSessionTaskWithWorkflowStatus;
  const monitor = (id: string, status: Status) =>
    ({
      ...base,
      id,
      kind: 'monitor',
      status,
    }) as DaemonSessionTaskWithWorkflowStatus;
  const workflow = (id: string, status: Status, isHistorical = false) =>
    ({
      ...base,
      id,
      kind: 'workflow',
      status,
      isHistorical,
      isBackgrounded: true,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    }) as DaemonSessionTaskWithWorkflowStatus;
  const summary = (
    tasks: DaemonSessionTaskWithWorkflowStatus[],
    includeAgents = true,
  ) =>
    getComposerTaskChipGroups(tasks, { includeAgents }).map((group) => [
      group.kind,
      group.tasks.map((task) => task.id),
    ]);

  it('groups unfinished tasks by kind in a fixed order', () => {
    expect(
      summary([
        shell('shell-1', 'running'),
        monitor('monitor-1', 'running'),
        agent('agent-1', 'running'),
        workflow('workflow-1', 'running'),
        agent('agent-2', 'paused'),
        shell('shell-2', 'running'),
        workflow('workflow-2', 'pausing'),
        workflow('workflow-3', 'paused'),
      ]),
    ).toEqual([
      ['workflow', ['workflow-1', 'workflow-2', 'workflow-3']],
      ['agent', ['agent-1']],
      ['shell', ['shell-1', 'shell-2']],
      ['monitor', ['monitor-1']],
    ]);
  });

  it('drops finished tasks so no "done" chip lingers', () => {
    const finished: Status[] = ['completed', 'failed', 'cancelled'];
    expect(
      summary(
        finished.flatMap((status) => [
          shell(`shell-${status}`, status),
          monitor(`monitor-${status}`, status),
          workflow(`workflow-${status}`, status),
          agent(`agent-${status}`, status),
        ]),
      ),
    ).toEqual([]);
  });

  it('leaves out workflow history, foreground agents and parked agents', () => {
    expect(
      summary([
        workflow('history', 'running', true),
        agent('foreground', 'running', false),
        // Paused agents are retained all session; a chip would never clear.
        agent('parked', 'paused'),
      ]),
    ).toEqual([]);
  });

  it('leaves out background agents when the host asks it to', () => {
    expect(
      summary(
        [agent('agent-1', 'running'), shell('shell-1', 'running')],
        false,
      ),
    ).toEqual([['shell', ['shell-1']]]);
  });
});

describe('buildTaskExplainQuestion', () => {
  const en = getTranslator('en');
  const zh = getTranslator('zh-CN');
  const shellTask: DaemonSessionTaskWithWorkflowStatus = {
    ...base,
    kind: 'shell',
    runtimeMs: 65_000,
    command: 'npm run dev',
    cwd: '/workspace',
  };
  const workflowTask: DaemonSessionTaskWithWorkflowStatus = {
    ...base,
    kind: 'workflow',
    isBackgrounded: true,
    currentPhase: 'Review',
    phaseVisits: [],
    dispatches: [],
    agentsDispatched: 4,
    agentsCompleted: 2,
    tokensSpent: 0,
    tokenBudgetTotal: null,
    recentLogs: ['log-0', 'log-1', 'log-2', 'log-3', 'log-4', 'log-5', 'log-6'],
    pendingApprovalCount: 1,
  };

  it('carries the shell command, working directory and elapsed time', () => {
    const question = buildTaskExplainQuestion(shellTask, en);
    expect(question).toContain('This session has a background task');
    expect(question).toContain('Kind: shell');
    expect(question).toContain('Status: running');
    expect(question).toContain('Elapsed: 1m 5s');
    expect(question).toContain('Command: npm run dev');
    expect(question).toContain('Working directory: /workspace');
  });

  it('carries the agent prompt and only the last five activities', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        subagentType: 'code-reviewer',
        prompt: 'Review the auth changes',
        recentActivities: Array.from({ length: 7 }, (_, i) => ({
          name: `tool-${i}`,
          description: `did thing ${i}`,
          at: i,
        })),
      },
      en,
    );
    expect(question).toContain('Agent type: code-reviewer');
    expect(question).toContain('Task prompt: Review the auth changes');
    expect(question).toContain('Recent activity: tool-2: did thing 2');
    expect(question).toContain('Recent activity: tool-6: did thing 6');
    expect(question).not.toContain('tool-1: did thing 1');
  });

  it('caps the prompt excerpt so one field cannot swamp the question', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        prompt: 'p'.repeat(5_000),
      },
      en,
    );
    expect(question).toContain('p'.repeat(1_200));
    expect(question).not.toContain('p'.repeat(1_201));
  });

  it('carries the monitor command and event count', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'monitor',
        command: 'watch logs',
        eventCount: 12,
        lastEventTime: 0,
        droppedLines: 0,
      },
      en,
    );
    expect(question).toContain('Command: watch logs');
    expect(question).toContain('Events observed: 12');
  });

  it('carries workflow phase, progress, approvals and the log tail', () => {
    const question = buildTaskExplainQuestion(workflowTask, en);
    expect(question).toContain('Current phase: Review');
    expect(question).toContain('Agents completed: 2/4');
    expect(question).toContain('Pending approvals: 1');
    expect(question).toContain('Recent log: log-2');
    expect(question).toContain('Recent log: log-6');
    expect(question).not.toContain('Recent log: log-1');
  });

  it('fits the daemon side-question cap in every UI language', () => {
    // Every field is excerpt-capped, so a maximal task stays within the
    // budget through the per-field cuts alone; the ellipsis asserted below
    // comes from those excerpts. The final guard has dedicated cases too.
    const task: DaemonSessionTaskWithWorkflowStatus = {
      ...base,
      kind: 'agent',
      isBackgrounded: true,
      label: 'L'.repeat(20_000),
      prompt: 'p'.repeat(20_000),
    };
    for (const t of [en, zh]) {
      const question = buildTaskExplainQuestion(task, t);
      expect(question.length).toBeLessThanOrEqual(4096);
      expect(question).toContain('…');
    }
  });

  it('does not strand a surrogate when the cut lands inside an emoji', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        // The leading 'x' forces the 400-char cut inside a pair; a pure
        // emoji string would cut on a pair boundary and skip the guard.
        label: 'x' + '😀'.repeat(10_000),
      },
      en,
    );
    expect(question.length).toBeLessThanOrEqual(4096);
    expect(question).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(question).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('writes the instruction in the UI language', () => {
    expect(buildTaskExplainQuestion(shellTask, zh)).toContain(
      '这个会话有一个后台任务',
    );
    expect(buildTaskExplainQuestion(shellTask, en)).toContain(
      'This session has a background task',
    );
  });

  it('omits absent agent fields instead of emitting empty lines', () => {
    const question = buildTaskExplainQuestion(
      { ...base, kind: 'agent', isBackgrounded: true },
      en,
    );
    expect(question).toContain('Kind: agent');
    expect(question).not.toContain('Task prompt:');
    expect(question).not.toContain('Agent type:');
    expect(question).not.toContain('Recent activity:');
  });

  it('omits phase, approval and log lines for a quiet workflow', () => {
    const question = buildTaskExplainQuestion(
      {
        ...workflowTask,
        currentPhase: null,
        agentsDispatched: 0,
        agentsCompleted: 0,
        recentLogs: [],
        pendingApprovalCount: 0,
      },
      en,
    );
    expect(question).toContain('Agents completed: 0/0');
    expect(question).not.toContain('Current phase:');
    expect(question).not.toContain('Pending approvals:');
    expect(question).not.toContain('Recent log:');
  });

  it('trims whitespace around the command excerpt', () => {
    const question = buildTaskExplainQuestion(
      { ...shellTask, command: '  npm run dev  ' },
      en,
    );
    expect(question).toContain('Command: npm run dev');
    expect(question).not.toContain('Command:   npm');
  });

  it('caps an uncapped field like the working directory', () => {
    const question = buildTaskExplainQuestion(
      { ...shellTask, cwd: '/w'.repeat(5_000) },
      en,
    );
    expect(question.length).toBeLessThanOrEqual(4096);
    expect(question).toContain('…');
  });

  it('fires the final guard one char past the facts budget', () => {
    // The working directory is uncapped, so it alone can overflow the
    // budget after every per-field excerpt has been applied.
    const overhead = en('tasks.explain.question', { facts: '' }).length;
    const scaffold =
      'Kind: shell\nLabel: task\nStatus: running\nElapsed: 1m 5s\n' +
      'Description: task\nCommand: npm run dev\nWorking directory: ';
    const budget = 4096 - overhead;
    const question = buildTaskExplainQuestion(
      { ...shellTask, cwd: 'w'.repeat(budget - scaffold.length + 1) },
      en,
    );
    expect(question.length).toBeLessThanOrEqual(4096);
    expect(question.endsWith('…')).toBe(true);
  });

  it('keeps the kind facts when the label is huge', () => {
    const question = buildTaskExplainQuestion(
      {
        ...shellTask,
        label: 'L'.repeat(20_000),
        command: 'npm run dev',
        cwd: '/workspace',
      },
      en,
    );
    expect(question).toContain('Command: npm run dev');
    expect(question).toContain('Working directory: /workspace');
    expect(question).toContain('L'.repeat(400));
    expect(question).not.toContain('L'.repeat(401));
  });

  it('caps the command excerpt at 500 characters', () => {
    const question = buildTaskExplainQuestion(
      { ...shellTask, command: 'c'.repeat(5_000) },
      en,
    );
    expect(question).toContain('c'.repeat(500));
    expect(question).not.toContain('c'.repeat(501));
  });

  it('caps the description excerpt at 400 characters', () => {
    const question = buildTaskExplainQuestion(
      { ...shellTask, description: 'd'.repeat(5_000) },
      en,
    );
    expect(question).toContain('d'.repeat(400));
    expect(question).not.toContain('d'.repeat(401));
  });

  it('caps each activity excerpt at 160 characters', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        recentActivities: [
          { name: 'tool', description: 'a'.repeat(5_000), at: 0 },
        ],
      },
      en,
    );
    // The cap applies to the combined "name: description" string.
    const line = question
      .split('\n')
      .find((l) => l.startsWith('Recent activity:'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual('Recent activity: '.length + 161);
    expect(line).toContain('…');
  });

  it('caps each log excerpt at 200 characters', () => {
    const question = buildTaskExplainQuestion(
      { ...workflowTask, recentLogs: ['l'.repeat(5_000)] },
      en,
    );
    expect(question).toContain('l'.repeat(200));
    expect(question).not.toContain('l'.repeat(201));
  });

  it('emits a daemon-shaped shell command exactly once', () => {
    // The daemon sets label and description to the command itself.
    const question = buildTaskExplainQuestion(
      {
        ...shellTask,
        label: 'npm run dev',
        description: 'npm run dev',
        command: 'npm run dev',
      },
      en,
    );
    expect(question.split('npm run dev').length - 1).toBe(1);
    expect(question).not.toContain('Label:');
    expect(question).not.toContain('Description:');
    expect(question).toContain('Working directory: /workspace');
  });

  it('keeps the monitor description as its label without duplicating it', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'monitor',
        label: 'watch logs',
        description: 'watch logs',
        command: 'tail -f app.log',
        eventCount: 3,
        lastEventTime: 0,
        droppedLines: 0,
      },
      en,
    );
    expect(question).toContain('Label: watch logs');
    expect(question).not.toContain('Description:');
    expect(question).toContain('Command: tail -f app.log');
  });

  it('skips an agent description that repeats its label', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        label: 'Review the change',
        description: 'Review the change',
      },
      en,
    );
    expect(question).toContain('Label: Review the change');
    expect(question).not.toContain('Description:');
  });

  it('strands no surrogate when the final guard cuts inside an emoji', () => {
    // Both parities: the cut offset depends on the template length, so one
    // variant always lands inside a pair even if the template changes.
    for (const cwd of ['😀'.repeat(10_000), 'w' + '😀'.repeat(10_000)]) {
      const question = buildTaskExplainQuestion({ ...shellTask, cwd }, en);
      expect(question.length).toBeLessThanOrEqual(4096);
      expect(question).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });

  it('strands no surrogate when a field excerpt cuts inside an emoji', () => {
    const question = buildTaskExplainQuestion(
      {
        ...base,
        kind: 'agent',
        isBackgrounded: true,
        prompt: 'a'.repeat(1_199) + '😀' + 'b'.repeat(100),
      },
      en,
    );
    expect(question).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe('explainDisplayLabel', () => {
  it('keeps a short label verbatim', () => {
    expect(explainDisplayLabel('npm run dev')).toBe('npm run dev');
  });

  it('caps a multi-KB command label for the panel echo', () => {
    const label = 'echo ' + 'x'.repeat(4_000);
    const display = explainDisplayLabel(label);
    expect(display.length).toBeLessThanOrEqual(121);
    expect(display.endsWith('…')).toBe(true);
  });

  it('strands no surrogate when the display cut lands inside an emoji', () => {
    // The leading 'x' forces the 120-char cut inside a pair; a pure emoji
    // string would cut on a pair boundary and skip the guard.
    const display = explainDisplayLabel('x' + '😀'.repeat(200));
    expect(display).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});
