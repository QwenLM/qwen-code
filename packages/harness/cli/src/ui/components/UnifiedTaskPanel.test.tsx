/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  makeFakeConfig,
  TaskRegistry,
  type InternalAgentUnifiedTask,
  type VideoGenUnifiedTask,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { TaskRegistryProvider } from '../contexts/TaskRegistryContext.js';
import { UnifiedTaskPanel, WorkflowTaskDetailView } from './UnifiedTaskPanel.js';
import { truncateWorkflowDisplayText } from './WorkflowPanel.js';
import type { Key } from '../contexts/KeypressContext.js';

function renderWorkflowDetail(
  task: WorkflowUnifiedTask,
  registry: TaskRegistry,
  width = 120,
) {
  const tree: React.ReactElement = (
    <TaskRegistryProvider registry={registry}>
      <WorkflowTaskDetailView task={task} onBack={() => {}} />
    </TaskRegistryProvider>
  );
  return renderWithProviders(tree, { width });
}

function makeWorkflowTask(): WorkflowUnifiedTask {
  const controller = new AbortController();
  return {
    id: 'wf-task',
    type: 'local_workflow',
    status: 'running',
    description: 'workflow task',
    startTime: Date.now(),
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: 'wf_test',
    workflowName: 'audit',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/workflows/wf_test/transcripts',
    progress: [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'inspect',
        state: 'progress',
      },
    ],
    logs: [],
    agentCount: 1,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    agentControllers: {
      '1': controller,
    },
  };
}

function makeInternalAgentTask(
  overrides: Partial<InternalAgentUnifiedTask> = {},
): InternalAgentUnifiedTask {
  return {
    id: 'internal-auto-memory',
    type: 'internal_agent',
    status: 'running',
    description: 'Memory',
    startTime: Date.now(),
    notified: false,
    executionId: -1,
    completionBehavior: 'silent',
    agentName: 'Memory',
    agentType: 'memory',
    prompt: 'Memory',
    phase: 'running',
    isBackgrounded: true,
    killable: false,
    ...overrides,
  };
}

function key(sequence: string): Key {
  return {
    name: sequence,
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: true,
    sequence,
  };
}

describe('WorkflowTaskDetailView', () => {
  it('shows video server status without a synthetic percentage', async () => {
    const registry = new TaskRegistry();
    const task: VideoGenUnifiedTask = {
      id: 'v-video_01test',
      type: 'local_video_gen',
      status: 'running',
      serverStatus: 'in_progress',
      description: 'small bird flying',
      startTime: Date.now(),
      notified: false,
      executionId: 42,
      completionBehavior: 'notify',
      isBackgrounded: true,
      videoId: 'video_01test',
      prompt: 'small bird flying',
      model: 'wan30',
      seconds: 2,
      size: '720P',
    };

    const { lastFrame, unmount } = await renderWithProviders(
      <TaskRegistryProvider registry={registry}>
        <UnifiedTaskPanel tasks={[task]} />
      </TaskRegistryProvider>,
      { width: 120 },
    );

    expect(lastFrame()).toContain('in progress');
    expect(lastFrame()).toContain('VideoGen');
    expect(lastFrame()).not.toContain('wan30');
    expect(lastFrame()).not.toContain('%');
    unmount();
  });

  it('renders internal memory and dream agents in the unified panel', async () => {
    const registry = new TaskRegistry();
    const tasks = [
      makeInternalAgentTask(),
      makeInternalAgentTask({
        id: 'internal-auto-dream',
        executionId: -2,
        description: 'Dreaming',
        agentName: 'Dreaming',
        agentType: 'dream',
        phase: 'running',
      }),
    ];

    const { lastFrame, unmount } = await renderWithProviders(
      <TaskRegistryProvider registry={registry}>
        <UnifiedTaskPanel tasks={tasks} />
      </TaskRegistryProvider>,
      { width: 120 },
    );

    expect(lastFrame()).toContain('Background agents (2)');
    expect(lastFrame()).toContain('Memory');
    expect(lastFrame()).toContain('Dreaming');
    expect(lastFrame()).toContain('Enter details');
    expect(lastFrame()).not.toContain('k kill');

    unmount();
  });

  it('renders per-agent skip/retry affordances for controllable workflow agents', async () => {
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();

    const { lastFrame, unmount } = await renderWorkflowDetail(task, registry);

    expect(lastFrame()).toContain('audit');
    expect(lastFrame()).toContain('workflow task');
    expect(lastFrame()).toContain('inspect');
    expect(lastFrame()).toContain('k stop workflow');
    expect(lastFrame()).toContain('Enter details');

    unmount();
  });

  it('renders a stable workflow detail snapshot with phases, agents, and result', async () => {
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_phase',
        index: 1,
        title: 'Plan',
        detail: 'Inspect repository',
      },
      {
        type: 'workflow_phase',
        index: 2,
        title: 'Verify',
      },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'inspect',
        state: 'done',
        promptPreview: 'Inspect src/value.ts',
        resultPreview: 'value is 42',
        tokens: 120,
        toolCalls: 2,
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'verify',
        state: 'progress',
        attempt: 2,
        maxAttempts: 3,
      },
    ];
    task.logs = ['phase=Plan', 'agent inspect completed'];
    task.agentCount = 2;
    task.totalTokens = 120;
    task.totalToolCalls = 2;
    task.result = { ok: true, value: 42 };

    const { lastFrame, unmount } = await renderWorkflowDetail(task, registry);

    expect(lastFrame()).toContain('audit');
    expect(lastFrame()).toContain('workflow task');
    expect(lastFrame()).toContain('1/2 agents');
    expect(lastFrame()).toContain('Phases');
    expect(lastFrame()).toContain('Plan');
    expect(lastFrame()).toContain('Verify');
    expect(lastFrame()).toContain('All · 2 agents');
    expect(lastFrame()).toContain('inspect');
    expect(lastFrame()).toContain('verify');
    expect(lastFrame()).not.toContain('Logs');
    expect(lastFrame()).not.toContain('phase=Plan');
    expect(lastFrame()).not.toContain('120');

    unmount();
  });

  it('routes stop/restart shortcuts to TaskRegistry workflow agent controls in agent detail', async () => {
    const registry = new TaskRegistry();
    const skipWorkflowAgent = vi.spyOn(registry, 'skipWorkflowAgent');
    const retryWorkflowAgent = vi.spyOn(registry, 'retryWorkflowAgent');
    const task = makeWorkflowTask();
    const skipController = task.agentControllers?.['1'];
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'inspect',
        state: 'progress',
        prompt: [
          'line 1',
          'line 2',
          'line 3',
          'line 4',
          'line 5 should appear after expand',
        ].join('\n'),
      },
    ];
    registry.register(task);

    const { capturedRegistry, lastFrame, unmount } = await renderWorkflowDetail(
      task,
      registry,
    );

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('x'))).toBe(false);
    });
    expect(skipWorkflowAgent).not.toHaveBeenCalled();

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:right',
          key(''),
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('x stop');
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });
    expect(lastFrame()).toContain('line 1');
    expect(lastFrame()).not.toContain('line 5 should appear after expand');

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Prompt expanded.');
      expect(lastFrame()).toContain('line 5 should appear after expand');
      expect(lastFrame()).toContain('x stop');
      expect(lastFrame()).toContain('r restart');
    });

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('x'))).toBe(true);
    });
    expect(skipWorkflowAgent).toHaveBeenCalledWith('wf-task', '1');
    expect(skipController?.signal.aborted).toBe(true);
    expect(skipController?.signal.reason).toBe('user-skip');
    await waitFor(() => {
      expect(lastFrame()).toContain('Skip requested for inspect.');
    });

    const retryController = new AbortController();
    registry.setWorkflowAgentController('wf-task', '1', retryController);

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('r'))).toBe(true);
    });
    expect(retryWorkflowAgent).toHaveBeenCalledWith('wf-task', '1');
    expect(retryController.signal.aborted).toBe(true);
    expect(retryController.signal.reason).toBe('user-retry');

    unmount();
  });

  it('scrolls expanded wrapped workflow prompts without changing selected agent', async () => {
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    const longPrompt = [
      'first-agent-prompt-start',
      ...Array.from({ length: 160 }, (_, index) => `chunk-${index}`),
      'prompt-tail-after-scroll',
    ].join(' ');
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'first-agent-detail',
        state: 'done',
        prompt: longPrompt,
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'second-agent-detail',
        state: 'done',
        prompt: 'second-agent-prompt',
      },
    ];
    task.agentCount = 2;

    const { capturedRegistry, lastFrame, unmount } = await renderWorkflowDetail(
      task,
      registry,
      100,
    );

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:right',
          key(''),
        ),
      ).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    expect(lastFrame()).toContain('first-agent-detail');
    expect(lastFrame()).toContain('first-agent-prompt-start');
    expect(lastFrame()).not.toContain('prompt-tail-after-scroll');

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Prompt expanded.');
    });
    expect(lastFrame()).not.toContain('prompt-tail-after-scroll');

    for (let index = 0; index < 40; index++) {
      await act(async () => {
        expect(capturedRegistry?.invokeFallback('Dialog', key('j'))).toBe(true);
      });
    }

    await waitFor(() => {
      expect(lastFrame()).toContain('prompt-tail-after-scroll');
      expect(lastFrame()).not.toContain('second-agent-prompt');
    });

    unmount();
  });

  it('cycles workflow agent status filters without mutating task progress', async () => {
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'done-agent',
        state: 'done',
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'running-agent',
        state: 'progress',
      },
      {
        type: 'workflow_agent',
        index: 3,
        label: 'failed-agent',
        state: 'error',
      },
    ];
    task.agentCount = 3;

    const { capturedRegistry, lastFrame, unmount } = await renderWorkflowDetail(
      task,
      registry,
    );

    expect(lastFrame()).toContain('All · 3 agents');
    expect(lastFrame()).toContain('done-agent');
    expect(lastFrame()).toContain('running-agent');
    expect(lastFrame()).toContain('failed-agent');

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('f'))).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('All · 1 agents · running');
      expect(lastFrame()).toContain('running-agent');
      expect(lastFrame()).not.toContain('done-agent');
    });
    expect(task.progress).toHaveLength(3);

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('f'))).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('All · 1 agents · failed');
      expect(lastFrame()).toContain('failed-agent');
      expect(lastFrame()).not.toContain('running-agent');
    });

    unmount();
  });

  it('pauses, resumes, and saves workflow scripts from the workflow panel', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-panel-'));
    try {
      const registry = new TaskRegistry();
      const task = makeWorkflowTask();
      const workflowAbortController = task.abortController;
      task.scriptPath = path.join(projectRoot, 'source-workflow.js');
      writeFileSync(
        task.scriptPath,
        'export const meta = { name: "audit", description: "Audit" };',
      );
      registry.register(task);

      const { capturedRegistry, lastFrame, unmount } =
        await renderWithProviders(
          <TaskRegistryProvider registry={registry}>
            <WorkflowTaskDetailView task={task} onBack={() => {}} />
          </TaskRegistryProvider>,
          {
            width: 120,
            config: makeFakeConfig({
              targetDir: projectRoot,
              cwd: projectRoot,
              sessionId: 'session-1',
            }),
          },
        );

      await act(async () => {
        expect(capturedRegistry?.invokeFallback('Dialog', key('p'))).toBe(true);
      });
      const registered = registry.get('wf-task');
      expect(registered?.type).toBe('local_workflow');
      if (registered?.type !== 'local_workflow') return;
      expect(registered.status).toBe('paused');
      expect(workflowAbortController?.signal.aborted).toBe(true);
      await waitFor(() => {
        expect(lastFrame()).toContain('Paused audit.');
      });
      unmount();

      const handleFinalSubmit = vi.fn(async () => {});
      const onBack = vi.fn();
      const pausedRender = await renderWithProviders(
        <TaskRegistryProvider registry={registry}>
          <WorkflowTaskDetailView task={registered} onBack={onBack} />
        </TaskRegistryProvider>,
        {
          width: 120,
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
          uiActions: { handleFinalSubmit },
        },
      );
      expect(pausedRender.lastFrame()).toContain('paused');
      expect(pausedRender.lastFrame()).toContain('p resume');
      expect(pausedRender.lastFrame()).toContain('k stop workflow');
      expect(pausedRender.lastFrame()).not.toContain('Paused audit.');
      await act(async () => {
        expect(
          pausedRender.capturedRegistry?.invokeFallback('Dialog', key('p')),
        ).toBe(true);
      });
      expect(onBack).toHaveBeenCalledTimes(1);
      expect(handleFinalSubmit).toHaveBeenCalledWith(
        "Resume the paused workflow by calling: Workflow({scriptPath: '" +
          task.scriptPath +
          "', resumeFromRunId: 'wf_test'}) — completed agents return cached results.",
      );

      await act(async () => {
        expect(
          pausedRender.capturedRegistry?.invokeFallback('Dialog', key('s')),
        ).toBe(true);
      });
      const savedPath = path.join(projectRoot, '.qwen', 'workflows', 'audit.js');
      await waitFor(() => {
        expect(existsSync(savedPath)).toBe(true);
        expect(pausedRender.lastFrame()).toContain('Saved workflow script:');
        expect(pausedRender.lastFrame()).toContain(savedPath);
      });
      expect(readFileSync(savedPath, 'utf8')).toBe(
        'export const meta = { name: "audit", description: "Audit" };',
      );

      await act(async () => {
        expect(
          pausedRender.capturedRegistry?.invokeFallback('Dialog', key('s')),
        ).toBe(true);
      });
      const fallbackPath = path.join(
        projectRoot,
        '.qwen',
        'workflows',
        'audit-wf_test.js',
      );
      await waitFor(() => {
        expect(existsSync(fallbackPath)).toBe(true);
        expect(pausedRender.lastFrame()).toContain(fallbackPath);
      });
      expect(readFileSync(fallbackPath, 'utf8')).toBe(
        'export const meta = { name: "audit", description: "Audit" };',
      );

      await act(async () => {
        expect(
          pausedRender.capturedRegistry?.invokeFallback('Dialog', key('k')),
        ).toBe(true);
      });
      expect(registry.get('wf-task')?.status).toBe('killed');

      pausedRender.unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('reports save workflow script failures without changing workflow state', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-panel-'));
    try {
      const registry = new TaskRegistry();
      const task = makeWorkflowTask();
      task.scriptPath = path.join(projectRoot, 'missing-workflow.js');
      registry.register(task);

      const { capturedRegistry, lastFrame, unmount } =
        await renderWithProviders(
          <TaskRegistryProvider registry={registry}>
            <WorkflowTaskDetailView task={task} onBack={() => {}} />
          </TaskRegistryProvider>,
          {
            width: 120,
            config: makeFakeConfig({
              targetDir: projectRoot,
              cwd: projectRoot,
              sessionId: 'session-1',
            }),
          },
        );

      await act(async () => {
        expect(capturedRegistry?.invokeFallback('Dialog', key('s'))).toBe(true);
      });

      await waitFor(() => {
        expect(lastFrame()).toContain('Failed to save workflow script:');
        expect(lastFrame()).toContain('missing-workflow.js');
      });
      const registered = registry.get('wf-task');
      expect(registered?.type).toBe('local_workflow');
      if (registered?.type !== 'local_workflow') return;
      expect(registered.status).toBe('running');

      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('truncates long agent detail prompts by display width', () => {
    const rendered = truncateWorkflowDisplayText(
      'Question: 这是一段很长很长的中文 prompt 内容，用来验证详情面板不会越过右侧边框 should-not-render-tail',
      34,
    );

    expect(rendered).toContain('Question:');
    expect(rendered).toContain('...');
    expect(rendered).not.toContain('should-not-render-tail');
  });
});
