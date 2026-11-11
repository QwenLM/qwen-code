/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { getSessionTranscriptPath } from '../../services/transcript-paths.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { Config } from '../../config/config.js';
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../services/messageQueueManager.js';
import { TaskRegistry } from '../../tasks/task-registry.js';
import type { AgentUnifiedTask } from '../../tasks/unified-task.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import type { AnyDeclarativeTool } from '../../tools/tools.js';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';
import { createAgentTeamTools } from './agent-team-tools.js';
import { registerTeammateController } from './agent-team-controller.js';
import { readAgentTaskRecord } from '../agent-task-runtime.js';
import { drainSubagentSdkEvents } from '../subagent-sdk-events.js';
import {
  readAgentTeamConfig,
  readTeamInbox,
  upsertAgentTeamMember,
} from './agent-team-runtime.js';

vi.mock('../agent-task-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-task-runtime.js')>();
  return {
    ...actual,
    readAgentTaskRecord: vi.fn(async () => null),
  };
});

function makeAgentTask(
  overrides: Partial<AgentUnifiedTask> = {},
): AgentUnifiedTask {
  return {
    id: 'a-agent-reviewer',
    type: 'local_agent',
    status: 'running',
    description: 'Review the implementation',
    startTime: Date.now(),
    notified: false,
    executionId: 1001,
    completionBehavior: 'notify',
    agentId: 'agent-reviewer',
    agentName: 'Reviewer',
    agentType: 'Reviewer',
    prompt: 'Review the implementation',
    isBackgrounded: true,
    taskId: 'agent-reviewer',
    ...overrides,
  };
}

function makeRuntime() {
  const taskRegistry = new TaskRegistry();
  const config = {
    getSessionId: () => 'session-root',
    getProjectRoot: () => '/tmp/project/.qwen/worktrees/session-root',
    getSessionArtifactProjectRoot: () => '/tmp/project',
    getActiveSessionTranscriptPath(this: Config): string {
      return getSessionTranscriptPath(
        this.getSessionArtifactProjectRoot(),
        this.getSessionId(),
      );
    },
    getAgentRegistry: () => ({
      getDefinition: () => undefined,
    }),
    taskRegistry,
  } as unknown as Config;
  const agentLoopContext = {
    config,
    taskRegistry,
  } as AgentLoopContext;
  return { config, taskRegistry, agentLoopContext };
}

async function executeSendMessage(params: {
  tool: AnyDeclarativeTool;
  agentLoopContext: AgentLoopContext;
  input: {
    to: string;
    message:
      | string
      | {
          type: 'shutdown_request';
          reason?: string;
        }
      | {
          type: 'shutdown_response';
          request_id: string;
          approve: boolean;
          reason?: string;
        };
    summary?: string;
  };
}) {
  const invocation = params.tool.build(params.input);
  return invocation.executeWithContext!({
    signal: new AbortController().signal,
    callId: 'toolu-send-message',
    agentLoopContext: params.agentLoopContext,
  } as ToolUseContext);
}

describe('SendMessage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-send-message-'));
    vi.stubEnv(ENV_CONFIG_DIR, tempDir);
    _resetConfigHomeDirCache();
    clearCommandQueue();
    drainSubagentSdkEvents('session-root', () => true);
    vi.mocked(readAgentTaskRecord).mockReset();
    vi.mocked(readAgentTaskRecord).mockResolvedValue(null);
  });

  afterEach(async () => {
    clearCommandQueue();
    drainSubagentSdkEvents('session-root', () => true);
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does not expose plan approval responses before plan mode is implemented', () => {
    const runtime = makeRuntime();
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];

    expect(JSON.stringify(tool.schema.parametersJsonSchema)).not.toContain(
      'plan_approval_response',
    );
  });

  it('exposes the source-aligned SendMessage prompt and schema', () => {
    const runtime = makeRuntime();
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];
    const description = tool.getSchema().description ?? '';
    const messageSchema = (
      tool.getSchema().parametersJsonSchema as {
        properties: {
          message: {
            oneOf: Array<{
              description?: string;
              properties?: Record<string, { description?: string }>;
            }>;
          };
        };
      }
    ).properties.message;

    expect(description).toContain('# SendMessage');
    expect(description).toContain('## Protocol responses (legacy)');
    expect(description).toContain('"to": "team-lead"');
    expect(messageSchema.oneOf[1]?.description).toBeUndefined();
    expect(
      messageSchema.oneOf[2]?.properties?.['request_id']?.description,
    ).toBe('must be the request id being responded to');
  });

  it('queues a message for a running background agent by agent ID', async () => {
    const runtime = makeRuntime();
    runtime.taskRegistry.register(makeAgentTask());
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];

    const result = await executeSendMessage({
      tool,
      agentLoopContext: runtime.agentLoopContext,
      input: {
        to: 'agent-reviewer',
        message: 'Check the new validation path.',
        summary: 'Review validation path',
      },
    });

    expect(result.toolUseResult).toMatchObject({
      success: true,
      routing: {
        target: 'agent-reviewer',
      },
    });
    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        prompt: 'Check the new validation path.',
        commandMode: 'prompt',
        targetAgentId: 'agent-reviewer',
        isMeta: true,
        origin: { kind: 'coordinator' },
      }),
    ]);
  });

  it('looks up a persisted background agent from the source project in a worktree', async () => {
    const runtime = makeRuntime();
    vi.mocked(readAgentTaskRecord).mockResolvedValueOnce({
      taskId: 'task-reviewer',
      sessionId: 'session-root',
      agentId: 'agent-reviewer',
      agentType: 'Reviewer',
      description: 'Review the implementation',
      teamName: 'different-team',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];

    await executeSendMessage({
      tool,
      agentLoopContext: runtime.agentLoopContext,
      input: {
        to: 'agent-reviewer',
        message: 'Check the final result.',
        summary: 'Check final result',
      },
    });

    expect(readAgentTaskRecord).toHaveBeenCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/tmp/project',
          'session-root',
        ),
      },
      'session-root',
      'agent-reviewer',
    );
  });

  it('delivers a teammate message to main without leaving it unread', async () => {
    const runtime = makeRuntime();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
        color: 'red',
      },
    });
    const teammateContext = {
      ...runtime.agentLoopContext,
      agentId: 'agent-architect',
    } as AgentLoopContext;
    runtime.taskRegistry.register(
      makeAgentTask({
        id: 'a-agent-architect',
        type: 'in_process_teammate',
        agentId: 'agent-architect',
        agentName: 'architect',
        taskId: 'task-architect',
      }),
    );
    const tool = createAgentTeamTools({
      config: runtime.config,
      teamName: 'session-session-',
      senderName: 'architect',
      agentLoopContext: teammateContext,
    })[0];

    const result = await executeSendMessage({
      tool,
      agentLoopContext: teammateContext,
      input: {
        to: 'main',
        message: 'The review is complete.',
        summary: 'Review completed',
      },
    });

    expect(result.toolUseResult).toMatchObject({
      success: true,
      message: "Message queued for the main conversation's next turn.",
    });
    expect(result.llmContent).toBe(
      JSON.stringify({
        success: true,
        message: "Message queued for the main conversation's next turn.",
      }),
    );
    expect(result.toolUseResult).not.toHaveProperty('wake');
    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'prompt',
        isMeta: true,
        origin: {
          kind: 'peer',
          from: 'architect',
          senderTaskId: 'task-architect',
          name: 'architect',
          body: 'The review is complete.',
        },
        displaySummary: 'Review completed',
        displayColor: 'red',
        prompt:
          '<agent-message from="architect">\nThe review is complete.\n</agent-message>',
      }),
    ]);
    await expect(
      readTeamInbox({
        teamName: 'session-session-',
        memberName: 'team-lead',
        unreadOnly: true,
      }),
    ).resolves.toEqual([]);
  });

  it('returns the mailbox message ID and sender color for teammate delivery', async () => {
    const runtime = makeRuntime();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
        color: 'red',
      },
    });
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'reviewer',
        agentId: 'agent-reviewer',
        taskId: 'task-reviewer',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
        color: 'blue',
      },
    });
    const unregisterController = registerTeammateController('agent-reviewer');
    const teammateContext = {
      ...runtime.agentLoopContext,
      agentId: 'agent-architect',
    } as AgentLoopContext;
    const tool = createAgentTeamTools({
      config: runtime.config,
      teamName: 'session-session-',
      senderName: 'architect',
      agentLoopContext: teammateContext,
    })[0];

    try {
      const result = await executeSendMessage({
        tool,
        agentLoopContext: teammateContext,
        input: {
          to: 'reviewer',
          message: 'Please inspect the API.',
          summary: 'Inspect API contract',
        },
      });
      const inbox = await readTeamInbox({
        teamName: 'session-session-',
        memberName: 'reviewer',
        unreadOnly: true,
      });

      expect(inbox).toEqual([
        expect.objectContaining({
          from: 'architect',
          color: 'red',
          summary: 'Inspect API contract',
        }),
      ]);
      expect(result.toolUseResult).toMatchObject({
        msg_id: inbox[0]?.id,
        routing: {
          sender: 'architect',
          senderColor: 'red',
          target: '@reviewer',
          targetColor: 'blue',
        },
      });
      expect(result.llmContent).toBe(JSON.stringify(result.toolUseResult));
    } finally {
      unregisterController();
    }
  });

  it('rejects structured team protocol from an ordinary background agent', async () => {
    const runtime = makeRuntime();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
      },
    });
    const backgroundAgentContext = {
      ...runtime.agentLoopContext,
      agentId: 'agent-reviewer',
    } as AgentLoopContext;
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: backgroundAgentContext,
    })[0];

    const result = await executeSendMessage({
      tool,
      agentLoopContext: backgroundAgentContext,
      input: {
        to: 'architect',
        message: {
          type: 'shutdown_request',
          reason: 'Stop now',
        },
      },
    });

    expect(result.toolUseResult).toMatchObject({
      success: false,
      from: 'agent-reviewer',
      to: 'architect',
    });
    expect(result.llmContent).toContain(
      'Structured team protocol messages can only be sent by teammates.',
    );
    expect(getCommandQueueSnapshot()).toEqual([]);
  });

  it('delivers a shutdown request with the model-visible protocol fields', async () => {
    const runtime = makeRuntime();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
      },
    });
    runtime.taskRegistry.register(
      makeAgentTask({
        id: 'a-agent-architect',
        type: 'in_process_teammate',
        agentId: 'agent-architect',
        agentName: 'architect',
        taskId: 'task-architect',
      }),
    );
    const tool = createAgentTeamTools({
      config: runtime.config,
      teamName: 'session-session-',
      agentLoopContext: runtime.agentLoopContext,
    })[0];
    const unregisterController = registerTeammateController('agent-architect');

    try {
      const result = await executeSendMessage({
        tool,
        agentLoopContext: runtime.agentLoopContext,
        input: {
          to: 'architect',
          message: {
            type: 'shutdown_request',
            reason: 'The work is complete.',
          },
        },
      });

      expect(result.toolUseResult).toMatchObject({
        success: true,
        request_id: expect.stringMatching(/^shutdown-\d+@architect$/),
      });
      const inbox = await readTeamInbox({
        teamName: 'session-session-',
        memberName: 'architect',
        unreadOnly: true,
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.text).toContain('"type":"shutdown_request"');
      expect(inbox[0]?.text).toContain(
        `"requestId":"${(result.toolUseResult as { request_id: string }).request_id}"`,
      );
      expect(inbox[0]?.text).not.toContain('"request_id"');
    } finally {
      unregisterController();
    }
  });

  it('does not route a message to a stopped roster member', async () => {
    const runtime = makeRuntime();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'stopped',
      },
    });
    const tool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];

    const result = await executeSendMessage({
      tool,
      agentLoopContext: runtime.agentLoopContext,
      input: {
        to: 'architect',
        message: 'Continue working.',
        summary: 'Continue previous work',
      },
    });

    expect(result.toolUseResult).toMatchObject({
      success: false,
      from: 'team-lead',
      to: 'architect',
    });
    expect(result.llmContent).toContain(
      "No agent named 'architect' is reachable",
    );
  });

  it('removes a teammate from the roster after shutdown approval', async () => {
    const runtime = makeRuntime();
    const abortController = new AbortController();
    await upsertAgentTeamMember({
      teamName: 'session-session-',
      leadSessionId: 'session-root',
      member: {
        name: 'architect',
        agentId: 'agent-architect',
        taskId: 'task-architect',
        agentType: 'Reviewer',
        sessionId: 'session-root',
        status: 'running',
      },
    });
    const teammateContext = {
      ...runtime.agentLoopContext,
      agentId: 'agent-architect',
    } as AgentLoopContext;
    runtime.taskRegistry.register(
      makeAgentTask({
        id: 'a-agent-architect',
        type: 'in_process_teammate',
        agentId: 'agent-architect',
        agentName: 'architect',
        taskId: 'agent-architect',
        teamName: 'session-session-',
        abortController,
      }),
    );
    const teammateTool = createAgentTeamTools({
      config: runtime.config,
      teamName: 'session-session-',
      senderName: 'architect',
      agentLoopContext: teammateContext,
    })[0];

    const approval = await executeSendMessage({
      tool: teammateTool,
      agentLoopContext: teammateContext,
      input: {
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'shutdown-1',
          approve: true,
        },
        summary: 'Approving shutdown request',
      },
    });

    expect(approval.toolUseResult).toEqual({
      success: true,
      message:
        'Shutdown approved. Sent confirmation to team-lead. Agent architect is now exiting.',
      request_id: 'shutdown-1',
    });
    expect(approval.llmContent).toBe(JSON.stringify(approval.toolUseResult));
    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'prompt',
        isMeta: true,
        origin: expect.objectContaining({
          kind: 'peer',
          from: 'architect',
        }),
        prompt: expect.stringContaining('"type":"shutdown_approved"'),
      }),
    ]);
    expect(getCommandQueueSnapshot()[0]?.prompt).toContain(
      '"requestId":"shutdown-1"',
    );
    expect(getCommandQueueSnapshot()[0]?.prompt).toContain(
      '"paneId":"in-process"',
    );
    expect(getCommandQueueSnapshot()[0]?.prompt).toContain(
      '"backendType":"in-process"',
    );
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe('shutdown-approved');
    expect(runtime.taskRegistry.get('a-agent-architect')).toMatchObject({
      status: 'killed',
      notified: true,
    });
    expect(drainSubagentSdkEvents('session-root', () => true)).toEqual([
      expect.objectContaining({
        subtype: 'background_tasks_changed',
        tasks: [],
      }),
      expect.objectContaining({
        subtype: 'task_updated',
        task_id: 'agent-architect',
        patch: expect.objectContaining({ status: 'killed' }),
      }),
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: 'agent-architect',
        status: 'stopped',
        output_file: '',
        summary: 'Review the implementation',
      }),
    ]);
    expect(
      (await readAgentTeamConfig('session-session-'))?.members.map(
        (member) => member.name,
      ),
    ).toEqual(['team-lead']);

    const mainTool = createAgentTeamTools({
      config: runtime.config,
      agentLoopContext: runtime.agentLoopContext,
    })[0];
    const followUp = await executeSendMessage({
      tool: mainTool,
      agentLoopContext: runtime.agentLoopContext,
      input: {
        to: 'architect',
        message: 'Continue working.',
        summary: 'Continue previous work',
      },
    });

    expect(followUp.toolUseResult).toMatchObject({
      success: false,
      from: 'team-lead',
      to: 'architect',
    });
  });
});
