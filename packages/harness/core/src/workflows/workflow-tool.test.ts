/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { runLocalAgentInvocation } from '../agents/local-agent-runner.js';
import { disposeSessionEventQueue } from '../agents/subagent-sdk-events.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from '../services/messageQueueManager.js';
import type { ToolUseContext } from '../tools/tool-types.js';
import { TaskStopTool } from '../tools/task-stop.js';
import { Kind } from '../tools/tools.js';
import { buildConfirmationDetails } from '../tools/confirmation-details-builder.js';
import {
  getWorkflowJournalPath,
  getWorkflowOutputPath,
  getWorkflowRunManifestPath,
  readWorkflowRunManifest,
  readWorkflowRunSnapshot,
  writeWorkflowRunManifest,
} from './workflow-storage.js';
import { WorkflowJournal } from './workflow-journal.js';
import { WorkflowTool } from './workflow-tool.js';


vi.mock('../agents/local-agent-runner.js', () => ({
  runLocalAgentInvocation: vi.fn(),
}));

const workflowFeatureConfig = {
  isWorkflowsEnabled: () => true,
} as unknown as Config;

function createConfig(
  projectRoot: string,
  taskRegistry: unknown,
  artifactProjectRoot = projectRoot,
): Config {
  return {
    ...workflowFeatureConfig,
    getProjectRoot: vi.fn(() => projectRoot),
    getSessionArtifactProjectRoot: vi.fn(() => artifactProjectRoot),
    getActiveSessionTranscriptPath: vi.fn(() =>
      path.join(artifactProjectRoot, 'session-1.jsonl'),
    ),
    getSessionId: vi.fn(() => 'session-1'),
    getWorkingDir: vi.fn(() => projectRoot),
    getTargetDir: vi.fn(() => projectRoot),
    taskRegistry,
  } as unknown as Config;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WorkflowTool permissions', () => {
  const tool = new WorkflowTool(workflowFeatureConfig);

  it('uses the workflow tool kind instead of the agent rendering kind', () => {
    expect(tool.kind).toBe(Kind.Workflow);
  });

  it('gives auto-mode review the whole script', () => {
    const script = `${'// pad\n'.repeat(400)}await agent('push --force');`;
    expect(tool.toClassifierInput({ script })).toMatchObject({ script });
  });

  it('uses the execution source priority for pending labels and confirmation metadata', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-confirmation-'));
    try {
      const scriptPath = path.join(projectRoot, 'from-path.js');
      const pathScript = `
export const meta = {
  name: 'from-path',
  description: 'Run the persisted path workflow',
  phases: [{ title: 'Path phase' }],
  inputSchema: { type: 'object', properties: { scope: { type: 'string' } } }
};
return args;
`;
      const inlineScript = `
export const meta = {
  name: 'from-inline',
  description: 'Run the ignored inline workflow',
  phases: [{ title: 'Inline phase' }]
};
return args;
`;
      writeFileSync(scriptPath, pathScript);

      const invocation = tool.build({
        script: inlineScript,
        name: 'ignored-name',
      });
      expect(invocation.getDescription()).toBe('Inline workflow script');

      const details = await buildConfirmationDetails(
        tool,
        {
          scriptPath,
          script: inlineScript,
          name: 'ignored-name',
          args: { scope: 'src' },
        },
        undefined,
        undefined,
        projectRoot,
      );

      expect(details).toMatchObject({
        type: 'workflow',
        source: 'scriptPath',
        workflowName: 'from-path',
        description: 'Run the persisted path workflow',
        script: pathScript,
        scriptPath,
        args: { scope: 'src' },
        meta: {
          name: 'from-path',
          description: 'Run the persisted path workflow',
          phases: [{ title: 'Path phase' }],
          inputSchema: {
            type: 'object',
            properties: { scope: { type: 'string' } },
          },
        },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('Workflow authoring repair hints', () => {
  const config = {
    isWorkflowsEnabled: () => true,
  } as unknown as Config;

  it.each([
    'export const meta = { name: "audit", description: "Audit" }; const x: number = 1;',
    'export const meta = { name: "audit", description: "Audit" }; return Date.now();',
    'export const meta = { name: "audit", description: "Audit" }; return Math.random();',
    'const name = "audit"; export const meta = { name, description: "Audit" };',
  ])(
    'uses source context for syntax errors without inventing an unavailable Skill hint: %s',
    (script) => {
      const updated = new WorkflowTool(config).validateToolParams({ script });
      if (script.includes('const x:')) {
        expect(updated).toContain('Script parse error: Unexpected token (1:68)');
        expect(updated).toContain('^');
        expect(updated).toContain('broken string quoting or escaping');
      }
      expect(updated).not.toContain('Check the literal meta declaration');
      expect(updated).not.toContain('Load the `workflow-authoring` skill');
    },
  );

  it('does not turn missing input or malformed resume ids into authoring errors', () => {
    const tool = new WorkflowTool(config);
    expect(tool.validateToolParams({})).toBe(
      'One of script, scriptPath, name, or resumeFromRunId is required.',
    );
    expect(tool.validateToolParams({ resumeFromRunId: 'bad' })).toBe(
      'resumeFromRunId must look like wf_<id>.',
    );
  });

  it('preserves scriptPath diagnostics without a callable guide and leaves args validation alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'workflow-repair-'));
    try {
      const cfg = { ...createConfig(dir, undefined), ...config } as Config;
      const scriptPath = path.join(dir, 'audit.js');
      writeFileSync(
        scriptPath,
        'export const meta = { name: "audit", description: "Audit" }; return Date.now();',
      );
      await expect(
        new WorkflowTool(cfg)
          .build({ scriptPath })
          .execute(new AbortController().signal),
      ).rejects.toThrow('Date.now() is unavailable in workflow scripts');
      writeFileSync(
        scriptPath,
        'export const meta = { name: "audit", description: "Audit", inputSchema: { type: "number" } }; return args;',
      );
      const invalidArgs = new WorkflowTool(cfg)
        .build({ scriptPath, args: {} })
        .execute(new AbortController().signal);
      await expect(invalidArgs).rejects.toThrow(/args/);
      await expect(invalidArgs).rejects.not.toThrow(
        'Check the literal meta declaration',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WorkflowTool execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetQueueForTest();
    ExecutionLifecycleService.resetForTest();
  });

  afterEach(() => {
    _resetQueueForTest();
    disposeSessionEventQueue('session-1');
    ExecutionLifecycleService.resetForTest();
  });

  it('launches a workflow, persists run state, updates the task, and queues completion notification', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    const artifactProjectRoot = path.join(projectRoot, 'session-artifacts');
    try {
      const taskRegistry = new TaskRegistry();
      const registerSpy = vi.spyOn(taskRegistry, 'register');
      const updateSpy = vi.spyOn(taskRegistry, 'update');
      const updateProgressSpy = vi.spyOn(
        taskRegistry,
        'updateWorkflowProgress',
      );
      const markNotifiedSpy = vi.spyOn(taskRegistry, 'markNotified');
      const config = createConfig(
        projectRoot,
        taskRegistry,
        artifactProjectRoot,
      );
      const tool = new WorkflowTool(config);
      const invocation = tool.build({
        script: `
export const meta = { name: "audit", description: "Audit repository", phases: [{ title: "Plan" }] };
phase('Plan');
log('started');
return { ok: true };
`,
        args: { scope: 'src' },
      });

      const customContext = Object.freeze({ tenant: 'alpha' });
      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-1',
        customContext,
      } as ToolUseContext);

      expect(result.data).toMatchObject({
        status: 'async_launched',
        summary: 'Audit repository',
        workflow_source: 'inline',
      });
      expect(result.returnDisplay).toBe(
        'Running in background · /workflows to monitor and save',
      );
      const launch = result.data as {
        runId: string;
        taskId: string;
        transcriptDir: string;
        scriptPath: string;
      };
      expect(launch.runId).toMatch(/^wf_/);
      expect(result.llmContent).toBe(
        [
          `Workflow launched in background. Task ID: ${launch.taskId}`,
          'Summary: Audit repository',
          `Transcript dir: ${launch.transcriptDir}`,
          `Script file: ${launch.scriptPath}`,
          `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${launch.scriptPath}"} to iterate without resending the script.)`,
          `Run ID: ${launch.runId}`,
          `To resume after editing the script: Workflow({scriptPath: "${launch.scriptPath}", resumeFromRunId: "${launch.runId}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
          '',
          'You will be notified when it completes. Use /workflows to watch live progress.',
        ].join('\n'),
      );
      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: launch.taskId,
          publicId: launch.taskId,
          sessionId: 'session-1',
          ownerAgentId: undefined,
          type: 'local_workflow',
          workflowRunId: launch.runId,
          workflowName: 'audit',
          status: 'running',
          toolUseId: 'workflow-call-1',
          outputPath: getWorkflowOutputPath(
            artifactProjectRoot,
            'session-1',
            launch.runId,
          ),
          abortController: expect.any(AbortController),
        }),
      );

      await waitFor(() =>
        updateSpy.mock.calls.some(
          ([taskId, patch]) =>
            taskId === launch.taskId && patch.status === 'completed',
        ),
      );

      const manifest = await readWorkflowRunManifest(
        artifactProjectRoot,
        'session-1',
        launch.runId,
      );
      expect(manifest).toMatchObject({
        runId: launch.runId,
        workflowName: 'audit',
        status: 'completed',
        args: { scope: 'src' },
      });
      expect(manifest.outputPath).toBeTruthy();
      expect(manifest.agents).toEqual([]);
      const outputPath = getWorkflowOutputPath(
        artifactProjectRoot,
        'session-1',
        launch.runId,
      );
      const output = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(output).toMatchObject({
        runId: launch.runId,
        taskId: launch.taskId,
        workflowName: 'audit',
        status: 'completed',
        result: { ok: true },
        failures: [],
        logs: ['started'],
        agentCount: 0,
        totalToolCalls: 0,
        usage: {
          agents: 0,
          toolCalls: 0,
        },
        transcriptDir: expect.stringContaining(launch.runId),
        scriptPath: expect.stringContaining('audit'),
      });
      expect(output).not.toHaveProperty('totalTokens');
      expect(output.usage).not.toHaveProperty('tokens');
      await waitFor(() => markNotifiedSpy.mock.calls.length > 0);
      const snapshot = await readWorkflowRunSnapshot(
        artifactProjectRoot,
        'session-1',
        launch.runId,
      );
      expect(snapshot).toMatchObject({
        runId: launch.runId,
        taskId: launch.taskId,
        workflowName: 'audit',
        status: 'completed',
        result: { ok: true },
        logs: ['started'],
      });
      expect(updateProgressSpy).toHaveBeenCalledWith(
        launch.taskId,
        [expect.objectContaining({ type: 'workflow_phase', title: 'Plan' })],
      );
      expect(updateProgressSpy).toHaveBeenCalledWith(
        launch.taskId,
        [expect.objectContaining({ type: 'workflow_log', message: 'started' })],
      );
      expect(getCommandQueueSnapshot()).toContainEqual(
        expect.objectContaining({
          commandMode: 'task-notification',
          priority: 'next',
          prompt: expect.stringContaining('Audit repository'),
          customContext,
        }),
      );
      expect(markNotifiedSpy).toHaveBeenCalledWith(launch.taskId);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes workflow agent index into the terminal manifest', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const agentProgress = [
        {
          type: 'workflow_agent' as const,
          index: 1,
          label: 'Cached reader',
          phaseIndex: 1,
          phaseTitle: 'Plan',
          state: 'done' as const,
          agentId: 'cached-agent',
          agentType: 'general-purpose',
          model: 'example-fast',
          journalKey: 'journal-cached',
          cached: true,
          outputPath: '/tmp/cached-output.json',
          transcriptPath: '/tmp/cached-transcript.jsonl',
        },
        {
          type: 'workflow_agent' as const,
          index: 2,
          label: 'Retry writer',
          phaseIndex: 1,
          phaseTitle: 'Plan',
          state: 'done' as const,
          agentId: 'retry-agent',
          agentType: 'reviewer',
          model: 'example-large',
          journalKey: 'journal-retry',
          attempt: 2,
          outputPath: '/tmp/retry-output.json',
          transcriptPath: '/tmp/retry-attempt-2.jsonl',
          attemptTranscriptPaths: [
            '/tmp/retry-attempt-1.jsonl',
            '/tmp/retry-attempt-2.jsonl',
          ],
        },
        {
          type: 'workflow_agent' as const,
          index: 3,
          label: 'Skipped optional',
          phaseIndex: 2,
          phaseTitle: 'Verify',
          state: 'skipped' as const,
          journalKey: 'journal-skipped',
          skipped: true,
        },
      ];
      const taskRegistry = {
        register: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
        get: vi.fn((taskId: string) => ({
          id: taskId,
          type: 'local_workflow',
          status: 'running',
          progress: agentProgress,
        })),
      };
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({
        script: `
export const meta = { name: "indexed", description: "Indexed manifest" };
return { ok: true };
`,
      });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-indexed',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };

      await waitFor(() =>
        taskRegistry.update.mock.calls.some(
          ([taskId, patch]) =>
            taskId === launch.taskId && patch.status === 'completed',
        ),
      );

      const manifest = await readWorkflowRunManifest(
        projectRoot,
        'session-1',
        launch.runId,
      );
      expect(manifest.agents).toEqual([
        expect.objectContaining({
          index: 1,
          label: 'Cached reader',
          phaseIndex: 1,
          phaseTitle: 'Plan',
          journalKey: 'journal-cached',
          agentId: 'cached-agent',
          agentType: 'general-purpose',
          model: 'example-fast',
          state: 'done',
          cached: true,
          outputPath: '/tmp/cached-output.json',
          transcriptPath: '/tmp/cached-transcript.jsonl',
          updatedAt: expect.any(String),
        }),
        expect.objectContaining({
          index: 2,
          label: 'Retry writer',
          phaseIndex: 1,
          phaseTitle: 'Plan',
          journalKey: 'journal-retry',
          agentId: 'retry-agent',
          agentType: 'reviewer',
          model: 'example-large',
          state: 'done',
          attempts: 2,
          outputPath: '/tmp/retry-output.json',
          transcriptPath: '/tmp/retry-attempt-2.jsonl',
          attemptTranscriptPaths: [
            '/tmp/retry-attempt-1.jsonl',
            '/tmp/retry-attempt-2.jsonl',
          ],
          updatedAt: expect.any(String),
        }),
        expect.objectContaining({
          index: 3,
          label: 'Skipped optional',
          phaseIndex: 2,
          phaseTitle: 'Verify',
          journalKey: 'journal-skipped',
          state: 'skipped',
          skipped: true,
          updatedAt: expect.any(String),
        }),
      ]);
      expect(taskRegistry.get).toHaveBeenCalledWith(launch.taskId);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks a failed execution in the task registry', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const taskRegistry = new TaskRegistry();
      const config = createConfig(projectRoot, taskRegistry);
      const invocation = new WorkflowTool(config).build({
        script: `
export const meta = { name: "failure", description: "Failure" };
throw new TypeError("private runtime detail");
`,
      });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-failed',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };
      await waitFor(() => taskRegistry.get(launch.taskId)?.status === 'failed');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('normalizes JSON-encoded container args before launching nested workflows', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const workflowsDir = path.join(projectRoot, '.qwen', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(
        path.join(workflowsDir, 'child.js'),
        `
export const meta = { name: "child", description: "Child nested smoke" };
return { childValue: args.value + "-child" };
`,
      );

      const taskRegistry = {
        register: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
      };
      const config = createConfig(projectRoot, taskRegistry);
      const tool = new WorkflowTool(config);
      const invocation = tool.build({
        script: `
export const meta = { name: "parent-nested", description: "Parent nested smoke" };
const child = await workflow("child", { value: args.value });
return { parent: args.value, child };
`,
        args: '{"value":"ok"}',
      });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-args',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };

      await waitFor(() =>
        taskRegistry.update.mock.calls.some(
          ([taskId, patch]) =>
            taskId === launch.taskId && patch.status === 'completed',
        ),
      );

      const manifest = await readWorkflowRunManifest(
        projectRoot,
        'session-1',
        launch.runId,
      );
      expect(manifest.args).toEqual({ value: 'ok' });
      const outputPath = getWorkflowOutputPath(
        projectRoot,
        'session-1',
        launch.runId,
      );
      await waitFor(
        () =>
          existsSync(outputPath) &&
          readFileSync(outputPath, 'utf8').trim().length > 0,
      );
      const output = JSON.parse(
        readFileSync(outputPath, 'utf8'),
      );
      expect(output.result).toEqual({
        parent: 'ok',
        child: { childValue: 'ok-child' },
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects resume from a workflow run that is still running', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const scriptPath = path.join(projectRoot, 'audit.js');
      writeFileSync(
        scriptPath,
        'export const meta = { name: "audit", description: "Audit" };',
      );
      await writeWorkflowRunManifest(projectRoot, 'session-1', {
        runId: 'wf_running1',
        workflowName: 'audit',
        scriptPath,
        source: 'inline',
        meta: { name: 'audit', description: 'Audit' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'running',
      });

      const taskRegistry = {
        register: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
        all: vi.fn(() => [
          {
            id: 'wf-live-task',
            type: 'local_workflow',
            status: 'running',
            workflowRunId: 'wf_running1',
          },
        ]),
      };
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({
        scriptPath,
        resumeFromRunId: 'wf_running1',
      });

      await expect(
        invocation.executeWithContext!({
          signal: new AbortController().signal,
        } as ToolUseContext),
      ).rejects.toThrow('task wf-live-task is still running');
      expect(taskRegistry.register).not.toHaveBeenCalled();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('preserves a TaskStop kill through workflow artifact finalization', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      vi.mocked(runLocalAgentInvocation).mockImplementation(
        ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            const rejectForAbort = () =>
              reject(new Error(String(signal?.reason ?? 'aborted')));
            if (signal?.aborted) {
              rejectForAbort();
              return;
            }
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          }),
      );
      const taskRegistry = new TaskRegistry();
      const config = createConfig(projectRoot, taskRegistry);
      const workflowInvocation = new WorkflowTool(config).build({
        script: `
export const meta = { name: "audit", description: "Audit" };
return await agent({ name: "reader", prompt: "Inspect the repository" });
`,
      });

      const launchResult = await workflowInvocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-stop',
      } as ToolUseContext);
      const launch = launchResult.data as { runId: string; taskId: string };
      await waitFor(() => vi.mocked(runLocalAgentInvocation).mock.calls.length > 0);

      const stopResult = await new TaskStopTool(config)
        .build({ task_id: launch.taskId })
        .executeWithContext!({
          signal: new AbortController().signal,
          config,
          sessionId: 'session-1',
        });

      expect(stopResult.toolUseResult).toMatchObject({
        task_id: launch.taskId,
        task_type: 'local_workflow',
      });
      expect(taskRegistry.get(launch.taskId)).toMatchObject({
        status: 'killed',
        notified: true,
        endTime: expect.any(Number),
        abortController: undefined,
        agentControllers: undefined,
      });

      const outputPath = getWorkflowOutputPath(
        projectRoot,
        'session-1',
        launch.runId,
      );
      const manifestPath = getWorkflowRunManifestPath(
        projectRoot,
        'session-1',
        launch.runId,
      );
      await waitFor(() => {
        if (!existsSync(outputPath) || !existsSync(manifestPath)) return false;
        try {
          return (
            JSON.parse(readFileSync(outputPath, 'utf8')).status === 'killed' &&
            JSON.parse(readFileSync(manifestPath, 'utf8')).status === 'killed'
          );
        } catch {
          return false;
        }
      });

      expect(taskRegistry.get(launch.taskId)).toMatchObject({
        status: 'killed',
        notified: true,
      });
      expect(getCommandQueueSnapshot().filter(command =>
        JSON.stringify(command.prompt).includes(`<task-id>${launch.taskId}</task-id>`),
      )).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects TaskStop after the workflow finalizer claims completion', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const taskRegistry = new TaskRegistry();
      const config = createConfig(projectRoot, taskRegistry);
      const workflowInvocation = new WorkflowTool(config).build({
        script: `
export const meta = { name: "quick", description: "Quick workflow" };
return { ok: true };
`,
      });

      const launchResult = await workflowInvocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-complete',
      } as ToolUseContext);
      const launch = launchResult.data as { runId: string; taskId: string };
      await waitFor(
        () => taskRegistry.get(launch.taskId)?.status === 'completed',
      );

      const stopResult = await new TaskStopTool(config)
        .build({ task_id: launch.taskId })
        .executeWithContext!({
          signal: new AbortController().signal,
          config,
          sessionId: 'session-1',
        });

      expect(stopResult.llmContent).toBe(
        `Task ${launch.taskId} is not running (status: completed)`,
      );
      expect(taskRegistry.get(launch.taskId)).toMatchObject({
        status: 'completed',
        abortController: undefined,
        agentControllers: undefined,
      });
      await waitFor(() => getCommandQueueSnapshot().length === 1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps a paused task in memory while winding down artifacts without notification', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      vi.mocked(runLocalAgentInvocation).mockImplementation(
        ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            const rejectForAbort = () =>
              reject(new Error(String(signal?.reason ?? 'aborted')));
            if (signal?.aborted) {
              rejectForAbort();
              return;
            }
            signal?.addEventListener('abort', rejectForAbort, { once: true });
          }),
      );
      const taskRegistry = new TaskRegistry();
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({
        script: `
export const meta = { name: "audit", description: "Audit" };
try {
  await agent({ name: "reader", prompt: "Inspect the repository" });
} catch {}
return await agent({ name: "ghost", prompt: "Must not run after pause" });
`,
      });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-pause',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };
      await waitFor(() => vi.mocked(runLocalAgentInvocation).mock.calls.length > 0);

      expect(taskRegistry.pauseWorkflow(launch.taskId)).toBe(true);
      const manifestPath = getWorkflowRunManifestPath(
        projectRoot,
        'session-1',
        launch.runId,
      );
      await waitFor(() => {
        if (!existsSync(manifestPath)) return false;
        try {
          return (
            JSON.parse(readFileSync(manifestPath, 'utf8')).status === 'killed'
          );
        } catch {
          return false;
        }
      });

      expect(taskRegistry.get(launch.taskId)).toMatchObject({
        status: 'paused',
        notified: true,
        endTime: expect.any(Number),
      });
      expect(getCommandQueueSnapshot()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runLocalAgentInvocation).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(runLocalAgentInvocation).mock.calls[0]?.[0].signal?.aborted,
      ).toBe(true);
      expect(
        existsSync(getWorkflowOutputPath(projectRoot, 'session-1', launch.runId)),
      ).toBe(false);
      expect(
        JSON.parse(readFileSync(manifestPath, 'utf8')),
      ).not.toHaveProperty('outputPath');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resumes into the same run with a new task and removes the paused task', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const scriptPath = path.join(projectRoot, 'audit.js');
      writeFileSync(
        scriptPath,
        'export const meta = { name: "audit", description: "Audit" }; return { ok: true };',
      );
      await writeWorkflowRunManifest(projectRoot, 'session-1', {
        runId: 'wf_paused1',
        workflowName: 'audit',
        scriptPath,
        source: 'inline',
        args: { scope: 'src' },
        meta: { name: 'audit', description: 'Audit' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        status: 'killed',
      });

      const pausedTask = {
        id: 'wf-paused-task',
        type: 'local_workflow',
        status: 'paused',
        workflowRunId: 'wf_paused1',
      };
      const taskRegistry = {
        register: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
        markNotified: vi.fn(),
        get: vi.fn(),
        all: vi.fn(() => [pausedTask]),
      };
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({
        scriptPath,
        resumeFromRunId: 'wf_paused1',
        args: { scope: 'src' },
      });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-resume',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };

      expect(launch.runId).toBe('wf_paused1');
      expect(launch.taskId).not.toBe(pausedTask.id);
      expect(taskRegistry.remove).toHaveBeenCalledWith(pausedTask.id);
      expect(taskRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: launch.taskId,
          workflowRunId: 'wf_paused1',
          status: 'running',
        }),
      );

      await waitFor(() =>
        taskRegistry.update.mock.calls.some(
          ([taskId, patch]) =>
            taskId === launch.taskId && patch.status === 'completed',
        ),
      );
      const manifest = await readWorkflowRunManifest(
        projectRoot,
        'session-1',
        launch.runId,
      );
      expect(manifest).toMatchObject({
        runId: 'wf_paused1',
        status: 'completed',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resumes legacy workflows with their original manifest and cached journal after session relocation', async () => {
    const projectRoot = mkdtempSync(
      path.join(tmpdir(), 'test-workflow-legacy-'),
    );
    const worktreeRoot = path.join(projectRoot, 'old-worktree');
    mkdirSync(worktreeRoot);
    try {
      const config = createConfig(projectRoot, new TaskRegistry());
      writeFileSync(
        config.getActiveSessionTranscriptPath(),
        [
          JSON.stringify({
            type: 'worktree-state',
            sessionId: 'session-1',
            worktreeSession: {
              originalCwd: projectRoot,
              worktreePath: worktreeRoot,
              worktreeName: 'legacy',
              sessionId: 'session-1',
            },
          }),
          JSON.stringify({
            type: 'worktree-state',
            sessionId: 'session-1',
            worktreeSession: null,
          }),
        ].join('\n') + '\n',
      );
      const runId = 'wf_legacy1';
      const scriptPath = path.join(worktreeRoot, 'audit.js');
      writeFileSync(
        scriptPath,
        'export const meta = { name: "audit", description: "Audit" }; return await agent({ prompt: "Read the repository" });',
      );
      await writeWorkflowRunManifest(worktreeRoot, 'session-1', {
        runId,
        workflowName: 'audit',
        scriptPath,
        source: 'inline',
        meta: { name: 'audit', description: 'Audit' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        status: 'killed',
      });
      const journal = await WorkflowJournal.load(
        getWorkflowJournalPath(worktreeRoot, 'session-1', runId),
      );
      const slot = await journal.nextCachedResult({
        prompt: 'Read the repository',
      });
      await journal.appendResult(slot.key, {
        content: 'Previously completed review',
        state: 'done',
      });
      const result = await new WorkflowTool(config).build({
        resumeFromRunId: runId,
      }).executeWithContext!({
        signal: new AbortController().signal,
        callId: 'legacy-workflow-resume',
      } as ToolUseContext);
      const launch = result.data as { taskId: string; transcriptDir: string };
      await waitFor(
        () => config.taskRegistry?.get(launch.taskId)?.status === 'completed',
      );
      expect(launch.transcriptDir).toBe(
        path.dirname(
          getWorkflowRunManifestPath(worktreeRoot, 'session-1', runId),
        ),
      );
      expect(
        (await readWorkflowRunSnapshot(worktreeRoot, 'session-1', runId)).result,
      ).toBe('Previously completed review');
      expect(runLocalAgentInvocation).not.toHaveBeenCalled();
      expect(
        existsSync(getWorkflowRunManifestPath(projectRoot, 'session-1', runId)),
      ).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('validates named workflow args against meta.inputSchema before launch', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const workflowsDir = path.join(projectRoot, '.qwen', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(
        path.join(workflowsDir, 'audit.js'),
        `
export const meta = {
  name: "audit",
  description: "Audit repository",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string", description: "Directory to audit" }
    },
    required: ["scope"],
    additionalProperties: false
  }
};
return { scope: args.scope };
`,
      );

      const taskRegistry = {
        register: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
      };
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({
        name: 'audit',
        args: { mode: 'full' },
      });

      await expect(
        invocation.executeWithContext!({
          signal: new AbortController().signal,
          callId: 'workflow-call-schema',
        } as ToolUseContext),
      ).rejects.toThrow(
        /Workflow args do not match audit meta\.inputSchema\..*required fields: scope.*properties: scope:string/,
      );
      expect(taskRegistry.register).not.toHaveBeenCalled();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('defaults missing schema args to an empty object', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'test-workflow-tool-'));
    try {
      const workflowsDir = path.join(projectRoot, '.qwen', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(
        path.join(workflowsDir, 'optional.js'),
        `
export const meta = {
  name: "optional",
  description: "Optional args",
  inputSchema: {
    type: "object",
    properties: { scope: { type: "string" } }
  }
};
return { keys: Object.keys(args) };
`,
      );

      const taskRegistry = {
        register: vi.fn(),
        update: vi.fn(),
        updateWorkflowProgress: vi.fn(),
      };
      const tool = new WorkflowTool(createConfig(projectRoot, taskRegistry));
      const invocation = tool.build({ name: 'optional' });

      const result = await invocation.executeWithContext!({
        signal: new AbortController().signal,
        callId: 'workflow-call-schema-default',
      } as ToolUseContext);
      const launch = result.data as { runId: string; taskId: string };
      await waitFor(() =>
        taskRegistry.update.mock.calls.some(
          ([taskId, patch]) =>
            taskId === launch.taskId && patch.status === 'completed',
        ),
      );
      const output = JSON.parse(
        readFileSync(
          getWorkflowOutputPath(projectRoot, 'session-1', launch.runId),
          'utf8',
        ),
      );
      expect(output.result).toEqual({ keys: [] });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
