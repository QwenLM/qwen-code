/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { act } from 'react';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cloneUsage,
  createWorkflowRegistryFromConfig,
  getProjectWorkflowsDir,
  makeFakeConfig,
  TaskRegistry,
  type Message,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { TaskRegistryProvider } from '../contexts/TaskRegistryContext.js';
import type { Key } from '../contexts/KeypressContext.js';
import { useWorkflowAgentTranscript } from '../hooks/useWorkflowAgentTranscript.js';
import { WorkflowPanel } from './WorkflowPanel.js';

vi.mock('../hooks/useWorkflowAgentTranscript.js', () => ({
  useWorkflowAgentTranscript: vi.fn(),
}));

const mockUseWorkflowAgentTranscript = vi.mocked(useWorkflowAgentTranscript);

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

function makeWorkflowTask(): WorkflowUnifiedTask {
  return {
    id: 'wf-task',
    type: 'local_workflow',
    status: 'completed',
    description: 'workflow task',
    startTime: 1,
    endTime: 2,
    notified: true,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: 'wf_test',
    workflowName: 'audit',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/workflows/wf_test',
    progress: [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'structured',
        state: 'done',
        resultPreview: 'preview only',
      },
    ],
    logs: [],
    agentCount: 1,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    agentControllers: {},
  };
}

describe('WorkflowPanel overview', () => {
  it('does not expand a structured workflow result in the overview', async () => {
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [];
    task.agentCount = 0;
    task.result = {
      ok: true,
      summary: 'large persisted result must stay out of the overview',
      report: Array.from(
        { length: 100 },
        (_, index) => `report line ${index + 1}`,
      ),
    };

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 160,
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('All · 0 agents');
      expect(output).not.toContain('large persisted result');
      expect(output).not.toContain('report line');
    });

    unmount();
  });

  it.each([false, true])(
    'saves a discoverable workflow in the original project (worktree: %s)',
    async (inWorktree) => {
      const root = await mkdtemp(path.join(tmpdir(), 'workflow-panel-save-'));
      const sourcePath = path.join(root, 'source.js');
      const script =
        'export const meta = { name: "audit", description: "Saved workflow" };\n';
      await writeFile(sourcePath, script);
      const config = makeFakeConfig({ targetDir: root, cwd: root });
      if (inWorktree) {
        const worktreeCwd = path.join(root, 'worktree');
        await mkdir(worktreeCwd);
        config.setTargetDir(worktreeCwd);
        config.setWorkingDir(worktreeCwd);
        config.setWorktreeSettings({
          name: 'feature',
          path: worktreeCwd,
          worktreeCwd,
          originalCwd: root,
          baseSha: '',
          lifecycle: 'attached',
        });
      }
      // 隔离其他 Skill/Plugin 的重载；保存文件和 Workflow 发现使用真实实现。
      const reloadSkills = vi
        .spyOn(config, 'reloadSkills')
        .mockResolvedValue(undefined);
      const registry = new TaskRegistry();
      const task = makeWorkflowTask();
      task.scriptPath = sourcePath;

      const tree: React.ReactElement = (
        <TaskRegistryProvider registry={registry}>
          <WorkflowPanel task={task} onBack={() => {}} />
        </TaskRegistryProvider>
      );
      const { capturedRegistry, lastFrame, unmount } =
        await renderWithProviders(tree, { config, width: 160 });

      try {
        await act(async () => {
          capturedRegistry?.invokeFallback('Dialog', key('s'));
        });
        await waitFor(() => {
          expect(reloadSkills).toHaveBeenCalled();
          expect(lastFrame()).toContain('Saved workflow script:');
        });
        await expect(
          createWorkflowRegistryFromConfig(config).resolve('audit'),
        ).resolves.toMatchObject({
          source: 'project',
          scriptPath: path.join(getProjectWorkflowsDir(root), 'audit.js'),
          script,
        });
      } finally {
        unmount();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('does not reload skills when workflow saving fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workflow-panel-failure-'));
    const config = makeFakeConfig();
    const reloadSkills = vi
      .spyOn(config, 'reloadSkills')
      .mockResolvedValue(undefined);
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.scriptPath = path.join(root, 'missing-workflow-script.js');

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { config, width: 160 },
    );

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('s'))).toBe(true);
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Failed to save workflow script:');
    });
    expect(reloadSkills).not.toHaveBeenCalled();
    unmount();
    await rm(root, { recursive: true, force: true });
  });
});

function structuredMessages(): Message[] {
  const timestamp = '2026-01-01T00:00:00.000Z';
  return [
    {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp,
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        model: 'test-model',
        stop_reason: 'tool_use',
        usage: { ...cloneUsage(), input_tokens: 1, output_tokens: 1 },
        content: [
          {
            type: 'tool_use',
            id: 'structured-call',
            name: 'StructuredOutput',
            input: { value: 42 },
          },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'tool-result-1',
      timestamp,
      toolUseResult: { value: 42 },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'structured-call',
            content: 'Structured output recorded successfully.',
            is_error: false,
          },
        ],
      },
    },
  ];
}

function detailMessages(): Message[] {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const usage = { ...cloneUsage(), input_tokens: 1, output_tokens: 1 };
  return [
    {
      type: 'user',
      uuid: 'user-prompt',
      timestamp,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Line one prompt',
              'Line two prompt',
              'Line three prompt',
              'Line four prompt',
              'Line five prompt',
              'Line six prompt',
            ].join('\n'),
          },
        ],
      },
    } as Message,
    {
      type: 'assistant',
      uuid: 'assistant-tools',
      timestamp,
      message: {
        id: 'msg-tools',
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        model: 'test-model',
        stop_reason: 'tool_use',
        usage,
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/repo/one.ts' },
          },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'Grep',
            input: { pattern: 'alpha' },
          },
          {
            type: 'tool_use',
            id: 'tool-3',
            name: 'Read',
            input: { file_path: '/repo/three.ts' },
          },
          {
            type: 'tool_use',
            id: 'tool-4',
            name: 'Bash',
            input: { command: 'npm test' },
          },
          {
            type: 'tool_use',
            id: 'tool-5',
            name: 'Read',
            input: { file_path: '/repo/five.ts' },
          },
        ],
      },
    } as Message,
    {
      type: 'user',
      uuid: 'tool-result-full-output',
      timestamp,
      toolUseResult: {
        content: 'full transcript tool output should stay hidden',
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-5',
            content: 'full transcript tool output should stay hidden',
            is_error: false,
          },
        ],
      },
    } as Message,
    {
      type: 'assistant',
      uuid: 'assistant-structured',
      timestamp,
      message: {
        id: 'msg-structured',
        type: 'message',
        role: 'assistant',
        stop_sequence: null,
        container: null,
        context_management: null,
        model: 'test-model',
        stop_reason: 'tool_use',
        usage,
        content: [
          {
            type: 'tool_use',
            id: 'structured-call',
            name: 'StructuredOutput',
            input: {
              subsystem: 'Workflow UI',
              overview:
                'A long outcome line that should wrap across the detail panel instead of being truncated.',
            },
          },
        ],
      },
    } as Message,
    {
      type: 'user',
      uuid: 'structured-result',
      timestamp,
      toolUseResult: {
        subsystem: 'Workflow UI',
        overview:
          'A long outcome line that should wrap across the detail panel instead of being truncated.',
        keyFiles: ['WorkflowPanel.tsx', 'workflow-tool.ts'],
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'structured-call',
            content: 'Structured output recorded successfully.',
            is_error: false,
          },
        ],
      },
    } as Message,
  ];
}

describe('<WorkflowPanel />', () => {
  it('uses k, not x, to stop or clear workflows from overview', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.status = 'running';
    task.endTime = undefined;
    registry.register(task);

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
    );

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('k stop workflow');
      expect(output).not.toContain('x stop workflow');
    });

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('x'))).toBe(false);
    });
    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('k'))).toBe(true);
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('Stop requested for audit.');
    });
    unmount();
  });

  it('updates running workflow elapsed time once per second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(31_000);
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.status = 'running';
    task.startTime = 1_000;
    task.endTime = undefined;

    try {
      const tree: React.ReactElement = (
        <TaskRegistryProvider registry={registry}>
          <WorkflowPanel task={task} onBack={() => {}} />
        </TaskRegistryProvider>
      );
      const { lastFrame, unmount, waitUntilReady } = await renderWithProviders(
        tree,
        { width: 160 },
      );

      expect(lastFrame()).toContain('30s');

      vi.setSystemTime(32_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await waitUntilReady();

      expect(lastFrame()).toContain('31s');
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders workflow agent detail summary metadata', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'metadata',
        state: 'error',
        agentType: 'general-purpose',
        model: 'example-large',
        attempt: 2,
        maxAttempts: 3,
        durationMs: 65_000,
        tokens: 321,
        toolCalls: 4,
        cached: true,
        skipped: true,
        error: 'failed after retry',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 180 },
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
    if (!lastFrame().includes('j/k scroll')) {
      await act(async () => {
        expect(
          capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
        ).toBe(true);
      });
    }

    await waitFor(() => {
      expect(lastFrame()).toContain('state: error');
      expect(lastFrame()).toContain('type: general-purpose');
      expect(lastFrame()).toContain('model: example-large');
      expect(lastFrame()).toContain('attempt 2/3');
      expect(lastFrame()).toContain('1m05s');
      expect(lastFrame()).toContain('321 tokens');
      expect(lastFrame()).toContain('4 tool calls');
      expect(lastFrame()).toContain('cached');
      expect(lastFrame()).toContain('skipped');
      expect(lastFrame()).toContain('error');
    });
    unmount();
  });

  it('prefers StructuredOutput transcript results for workflow agent outcome', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: structuredMessages(),
      loading: false,
      source: 'transcriptPath',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'structured',
        state: 'error',
        resultPreview: 'preview only',
        error: 'agent error should not hide structured outcome',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 120 },
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

    await waitFor(() => {
      expect(lastFrame()).toContain('"value": 42');
      expect(lastFrame()).not.toContain('preview only');
      expect(lastFrame()).not.toContain(
        'agent error should not hide structured outcome',
      );
    });
    unmount();
  });

  it('renders live workflow agent tool activity before transcript is available', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: true,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.status = 'running';
    task.endTime = undefined;
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'live agent',
        state: 'progress',
        model: 'example-large',
        toolCalls: 4,
        lastToolName: 'Read',
        lastToolSummary: '/repo/live.ts',
        recentToolActivities: [
          'Glob(**/*.ts)',
          'Grep(workflow)',
          'Read(/repo/live.ts)',
        ],
        lastProgressAt: 3_000,
        promptPreview: 'Read the live file',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
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

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('live agent');
      expect(output).toContain('Read');
      expect(output).toContain('4 tool');
    });

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('Activity · last 3 of 4 tool calls');
      expect(output).toContain('Glob(**/*.ts)');
      expect(output).toContain('Grep(workflow)');
      expect(output).toContain('Read(/repo/live.ts)');
      expect(output).not.toContain('Loading transcript...');
    });

    unmount();
  });

  it('renders prompt expansion, last-three activity, and multiline outcome in agent detail', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: detailMessages(),
      loading: false,
      source: 'transcriptPath',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'detail agent',
        state: 'done',
        model: 'example-large',
        tokens: 1234,
        toolCalls: 6,
        resultPreview: 'preview should not win',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
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
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('Prompt · 6 lines · ↵ expand');
      expect(output).toContain('... 2 more lines');
      expect(output).toContain('Activity · last 3 of 6 tool calls');
      expect(output).not.toContain('x stop agent');
      expect(output).not.toContain('· e prompt');
      expect(output).not.toContain('/repo/one.ts');
      expect(output).not.toContain('alpha');
      expect(output).toContain('/repo/three.ts');
      expect(output).toContain('npm test');
      expect(output).toContain('/repo/five.ts');
      expect(output).not.toContain(
        'full transcript tool output should stay hidden',
      );
      expect(output).toContain('Outcome');
      expect(output).toContain('... 8 more');
      expect(output).not.toContain('preview should not win');
    });

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('e'))).toBe(false);
    });
    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('x'))).toBe(false);
    });

    for (let index = 0; index < 5; index++) {
      await act(async () => {
        expect(capturedRegistry?.invokeFallback('Dialog', key('j'))).toBe(true);
      });
    }

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('"subsystem": "Workflow UI"');
      expect(output).toContain('"keyFiles": [');
    });

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('Prompt · 6 lines · expanded');
      expect(output).toContain('Line six prompt');
      expect(output).toContain('Activity · last 3 of 6 tool calls');
    });

    unmount();
  });

  it('does not accumulate hidden scroll offset after reaching workflow detail bounds', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: detailMessages(),
      loading: false,
      source: 'transcriptPath',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'bounded scroll agent',
        state: 'done',
        model: 'example-large',
        tokens: 1234,
        toolCalls: 6,
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
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
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('... 8 more');
    });

    for (let index = 0; index < 20; index++) {
      await act(async () => {
        expect(capturedRegistry?.invokeFallback('Dialog', key('j'))).toBe(true);
      });
    }

    await waitFor(() => {
      expect(lastFrame()).toContain('"keyFiles": [');
    });
    const bottomFrame = lastFrame();

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('k'))).toBe(true);
    });

    await waitFor(() => {
      expect(lastFrame()).not.toBe(bottomFrame);
    });

    unmount();
  });

  it('keeps arrow keys on agent selection while j/k scrolls agent detail', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'first agent',
        state: 'done',
        resultPreview: ['first outcome', 'line two', 'line three'].join('\n'),
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'second agent',
        state: 'progress',
        resultPreview: 'second outcome',
      },
    ];
    task.agentCount = 2;

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
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
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('first agent');
      expect(lastFrame()).toContain('first outcome');
    });

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('j'))).toBe(true);
    });
    await act(async () => {
      expect(capturedRegistry?.invokeFallback('Dialog', key('k'))).toBe(true);
    });
    expect(lastFrame()).not.toContain('Stop requested');
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:down',
          key(''),
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('second agent');
      expect(output).toContain('second outcome');
    });

    unmount();
  });

  it('drills from phases to agents before opening agent detail', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.progress = [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'phase enter agent',
        state: 'done',
        resultPreview: 'phase enter outcome',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
    );

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });
    expect(lastFrame()).not.toContain('j/k scroll');

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key('')),
      ).toBe(true);
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('phase enter agent');
      expect(output).toContain('phase enter outcome');
      expect(output).toContain('j/k scroll');
    });

    unmount();
  });

  it('resets the filter and agent selection when entering a phase', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    task.agentCount = 4;
    task.progress = [
      { type: 'workflow_phase', index: 1, title: 'Failed phase' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'first failed agent',
        phaseIndex: 1,
        phaseTitle: 'Failed phase',
        state: 'error',
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'second failed agent',
        phaseIndex: 1,
        phaseTitle: 'Failed phase',
        state: 'error',
      },
      { type: 'workflow_phase', index: 2, title: 'Done phase' },
      {
        type: 'workflow_agent',
        index: 3,
        label: 'first done agent',
        phaseIndex: 2,
        phaseTitle: 'Done phase',
        state: 'done',
        resultPreview: 'first done outcome',
      },
      {
        type: 'workflow_agent',
        index: 4,
        label: 'second done agent',
        phaseIndex: 2,
        phaseTitle: 'Done phase',
        state: 'done',
        resultPreview: 'second done outcome',
      },
    ];

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={() => {}} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      { width: 160 },
    );

    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key(''));
    });
    await act(async () => {
      capturedRegistry?.invokeFallback('Dialog', key('f'));
    });
    await act(async () => {
      capturedRegistry?.invokeFallback('Dialog', key('f'));
    });
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', key(''));
      capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:left', key(''));
    });
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', key(''));
      capturedRegistry?.invokeAction('Dialog', 'dialog:navigate:down', key(''));
    });
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key(''));
    });
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key(''));
    });

    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('first done agent');
      expect(output).toContain('first done outcome');
      expect(output).not.toContain('second done outcome');
      expect(output).toContain('f filter: all');
    });

    unmount();
  });

  it('moves left through detail, agents, phases, then closes', async () => {
    mockUseWorkflowAgentTranscript.mockReturnValue({
      messages: [],
      loading: false,
      source: 'none',
    });
    const registry = new TaskRegistry();
    const task = makeWorkflowTask();
    const onBack = vi.fn();

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <WorkflowPanel task={task} onBack={onBack} />
      </TaskRegistryProvider>
    );
    const { capturedRegistry, unmount } = await renderWithProviders(tree, {
      width: 160,
    });

    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        key(''),
      );
    });
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', key(''));
    });

    for (let index = 0; index < 3; index++) {
      await act(async () => {
        expect(
          capturedRegistry?.invokeAction(
            'Dialog',
            'dialog:navigate:left',
            key(''),
          ),
        ).toBe(true);
      });
    }

    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });
});
