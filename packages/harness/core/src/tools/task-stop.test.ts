/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { Config } from '../config/config.js';
import {
  drainSubagentSdkEvents,
  disposeSessionEventQueue,
} from '../agents/subagent-sdk-events.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import type {
  AgentUnifiedTask,
  BashUnifiedTask,
  InternalAgentUnifiedTask,
  WorkflowUnifiedTask,
} from '../tasks/unified-task.js';
import { TaskStopTool } from './task-stop.js';

function bashTask(overrides: Partial<BashUnifiedTask> = {}): BashUnifiedTask {
  return {
    id: 'b-b12345678',
    publicId: 'b12345678',
    sessionId: 'session-1',
    type: 'local_bash',
    status: 'running',
    description: 'background command',
    startTime: 1,
    notified: false,
    executionId: 101,
    completionBehavior: 'notify',
    command: 'sleep 60',
    isBackgrounded: true,
    output: '',
    ...overrides,
  };
}

function agentTask(overrides: Partial<AgentUnifiedTask> = {}): AgentUnifiedTask {
  return {
    id: 'a-agent-1',
    publicId: 'agent-1',
    sessionId: 'session-1',
    type: 'local_agent',
    status: 'running',
    description: 'inspect repository',
    startTime: 1,
    notified: false,
    executionId: 202,
    completionBehavior: 'notify',
    agentId: 'agent-1',
    agentName: 'Explore',
    agentType: 'Explore',
    prompt: 'Inspect repository',
    isBackgrounded: true,
    taskId: 'agent-1',
    ...overrides,
  };
}

function workflowTask(
  overrides: Partial<WorkflowUnifiedTask> = {},
): WorkflowUnifiedTask {
  return {
    id: 'wf-1',
    publicId: 'wf-1',
    sessionId: 'session-1',
    type: 'local_workflow',
    status: 'running',
    description: 'audit repository',
    startTime: 1,
    notified: false,
    executionId: 303,
    toolUseId: 'workflow-call-1',
    outputPath: '/tmp/workflow-output.json',
    completionBehavior: 'notify',
    workflowRunId: 'wf_run1',
    workflowName: 'audit',
    scriptPath: '/tmp/audit.js',
    transcriptDir: '/tmp/workflow-transcripts',
    progress: [],
    logs: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    agentControllers: {},
    ...overrides,
  };
}

function internalAgentTask(
  overrides: Partial<InternalAgentUnifiedTask> = {},
): InternalAgentUnifiedTask {
  return {
    id: 'internal-memory',
    publicId: 'internal-memory',
    sessionId: 'session-1',
    type: 'internal_agent',
    status: 'running',
    description: 'extract memories',
    startTime: 1,
    notified: false,
    executionId: -1,
    completionBehavior: 'silent',
    agentName: 'Memory',
    agentType: 'memory',
    prompt: 'Extract memories',
    isBackgrounded: true,
    killable: false,
    ...overrides,
  };
}

describe('TaskStopTool', () => {
  let registry: TaskRegistry;
  let config: Config;
  let killSpy: MockInstance<typeof ExecutionLifecycleService.kill>;

  beforeEach(() => {
    registry = new TaskRegistry();
    config = {
      getSessionId: vi.fn(() => 'session-1'),
      taskRegistry: registry,
    } as unknown as Config;
    killSpy = vi
      .spyOn(ExecutionLifecycleService, 'kill')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    disposeSessionEventQueue('session-1');
  });

  async function stop(taskId: string, agentId?: string) {
    const tool = new TaskStopTool(config);
    // @ts-expect-error createInvocation is protected by the declarative tool API.
    const invocation = tool.createInvocation({ task_id: taskId });
    return invocation.executeWithContext!({
      signal: new AbortController().signal,
      config,
      sessionId: 'session-1',
      agentId,
    });
  }

  it('uses the exact model-visible TaskStop description', () => {
    const schema = new TaskStopTool(config).getSchema();
    const parameters = schema.parametersJsonSchema as {
      properties: { task_id: { description: string } };
    };

    expect(schema.description).toBe(
      `- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- To stop an agent-team teammate, pass its agent ID ("name@team") or bare teammate name as task_id
- To stop a background agent spawned with a name, pass that name as task_id
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    );
    expect(parameters.properties.task_id.description).toBe(
      'The ID of the background task to stop. Agent-team teammates and named background agents are also accepted by agent ID or name.',
    );
  });

  it('returns the reference not-found and not-running errors', async () => {
    const missingResult = await stop('private-task-id');
    expect(missingResult.llmContent).toBe(
      'No task found with ID: private-task-id',
    );
    expect(missingResult.data).toMatchObject({
      tool_error_stage: 'parameter_validation',
      tool_error_subtype: 'missing_reference',
    });
    expect(
      JSON.parse(missingResult.data?.['tool_error_details_json'] as string),
    ).toEqual({
      schema_version: 1,
      validation_source: 'tool_execution',
      parameter_path: 'params.task_id',
      constraint_category: 'reference_not_found',
      quality: 'precise',
      validation_phase: 'execution',
    });
    expect(JSON.stringify(missingResult.data)).not.toContain('private-task-id');

    expect((await stop('missing')).llmContent).toBe(
      'No task found with ID: missing',
    );

    registry.register(bashTask({ status: 'completed' }));
    expect((await stop('b12345678')).llmContent).toBe(
      'Task b12345678 is not running (status: completed)',
    );
  });

  it('prevents one agent from stopping another owner\'s task', async () => {
    registry.register(bashTask({ ownerAgentId: 'agent-owner' }));

    expect((await stop('b12345678', 'agent-other')).llmContent).toBe(
      'Task b12345678 is owned by agent-owner; agent agent-other cannot stop it.',
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('allows the main session to stop a task owned by a child agent', async () => {
    registry.register(bashTask({ ownerAgentId: 'agent-owner' }));

    expect(await stop('b12345678')).toMatchObject({
      toolUseResult: {
        task_id: 'b12345678',
        task_type: 'local_bash',
      },
    });
    expect(killSpy).toHaveBeenCalledWith(101);
  });

  it('rejects task types without a background stop handler', async () => {
    registry.register(internalAgentTask());

    expect((await stop('internal-memory')).llmContent).toBe(
      'Unsupported task type: internal_agent',
    );
  });

  it('stops a killable internal memory agent', async () => {
    registry.register(
      internalAgentTask({
        executionId: 404,
        completionBehavior: 'notify',
        killable: true,
      }),
    );
    const markNotifiedSpy = vi.spyOn(
      ExecutionLifecycleService,
      'markNotified',
    );

    const result = await stop('internal-memory');

    expect(result.toolUseResult).toMatchObject({
      task_id: 'internal-memory',
      task_type: 'internal_agent',
    });
    expect(killSpy).toHaveBeenCalledWith(404, 'task_stop');
    expect(markNotifiedSpy).toHaveBeenCalledWith(404);
    expect(registry.get('internal-memory')).toMatchObject({
      status: 'killed',
      notified: true,
    });
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([
      expect.objectContaining({
        subtype: 'task_updated',
        task_id: 'internal-memory',
        patch: expect.objectContaining({ status: 'killed' }),
      }),
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: 'internal-memory',
        status: 'stopped',
      }),
      expect.objectContaining({
        subtype: 'background_tasks_changed',
        tasks: [],
      }),
    ]);
  });

  it('stops a local bash task and returns only the reference fields', async () => {
    registry.register(bashTask());

    const result = await stop('b12345678');

    expect(killSpy).toHaveBeenCalledWith(101);
    expect(result.toolUseResult).toEqual({
      message: 'Successfully stopped task: b12345678 (sleep 60)',
      task_id: 'b12345678',
      task_type: 'local_bash',
      command: 'sleep 60',
    });
  });

  it('marks a local agent killed and emits one stopped notification', async () => {
    registry.register(agentTask());
    const markNotifiedSpy = vi.spyOn(
      ExecutionLifecycleService,
      'markNotified',
    );

    const result = await stop('agent-1');

    expect(result.toolUseResult).toEqual({
      message: 'Successfully stopped task: agent-1 (inspect repository)',
      task_id: 'agent-1',
      task_type: 'local_agent',
      command: 'inspect repository',
    });
    expect(registry.get('a-agent-1')).toMatchObject({
      status: 'killed',
      notified: true,
    });
    expect(markNotifiedSpy).toHaveBeenCalledWith(202);
    expect(killSpy).toHaveBeenCalledWith(202);
    expect(killSpy.mock.invocationCallOrder[0]).toBeLessThan(
      markNotifiedSpy.mock.invocationCallOrder[0],
    );
    expect(
      drainSubagentSdkEvents('session-1', () => true),
    ).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent-1',
        patch: expect.objectContaining({ status: 'killed' }),
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-1',
        status: 'stopped',
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      }),
    ]);
  });

  it.each([
    ['agent ID', 'researcher@team'],
    ['bare name', 'researcher'],
  ])('stops a teammate by %s', async (_label, taskId) => {
    registry.register(
      agentTask({
        id: 'a-researcher',
        publicId: 'researcher-task',
        agentId: 'researcher@team',
        agentName: 'researcher',
        taskId: 'researcher-task',
      }),
    );

    expect(await stop(taskId)).toMatchObject({
      toolUseResult: {
        task_id: 'researcher-task',
        task_type: 'local_agent',
      },
    });
    expect(killSpy).toHaveBeenCalledWith(202);
  });

  it('stops an idle in-process teammate through the same task lifecycle', async () => {
    registry.register(
      agentTask({
        type: 'in_process_teammate',
        isIdle: true,
      }),
    );

    const result = await stop('agent-1');

    expect(result.toolUseResult).toEqual({
      message: 'Successfully stopped task: agent-1 (inspect repository)',
      task_id: 'agent-1',
      task_type: 'in_process_teammate',
      command: 'inspect repository',
    });
    expect(registry.get('a-agent-1')).toMatchObject({
      status: 'killed',
      notified: true,
    });
    expect(killSpy).toHaveBeenCalledWith(202);
  });

  it('stops a local workflow and emits one killed/stopped event pair', async () => {
    const topController = new AbortController();
    const agentController = new AbortController();
    registry.register(
      workflowTask({
        abortController: topController,
        agentControllers: { '1': agentController },
      }),
    );
    const markNotifiedSpy = vi.spyOn(
      ExecutionLifecycleService,
      'markNotified',
    );

    const result = await stop('wf-1');

    expect(result.toolUseResult).toEqual({
      message: 'Successfully stopped task: wf-1 (audit repository)',
      task_id: 'wf-1',
      task_type: 'local_workflow',
      command: 'audit repository',
    });
    expect(registry.get('wf-1')).toMatchObject({
      status: 'killed',
      notified: true,
      endTime: expect.any(Number),
      abortController: undefined,
      agentControllers: undefined,
    });
    expect(topController.signal.reason).toBe('task_stop');
    expect(agentController.signal.reason).toBe('task_stop');
    expect(markNotifiedSpy).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(303, 'task_stop');
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'wf-1',
        patch: expect.objectContaining({ status: 'killed' }),
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'wf-1',
        tool_use_id: 'workflow-call-1',
        status: 'stopped',
        output_file: '/tmp/workflow-output.json',
        summary: 'audit repository',
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      }),
    ]);

    expect((await stop('wf-1')).llmContent).toContain(
      'Task wf-1 is not running (status: killed)',
    );
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([]);
  });

  it('does not report success when the workflow kill cannot be confirmed', async () => {
    registry.register(workflowTask());
    vi.spyOn(registry, 'kill').mockImplementation((taskId) => {
      registry.remove(taskId);
    });

    expect((await stop('wf-1')).llmContent).toBe(
      'No task found with ID: wf-1',
    );
    expect(killSpy).not.toHaveBeenCalled();
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([]);
  });

  it('does not stop a paused workflow', async () => {
    registry.register(workflowTask({ status: 'paused', notified: true }));

    expect((await stop('wf-1')).llmContent).toBe(
      'Task wf-1 is not running (status: paused)',
    );
    expect(killSpy).not.toHaveBeenCalled();
  });
});
