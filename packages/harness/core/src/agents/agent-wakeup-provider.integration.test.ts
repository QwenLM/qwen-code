/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createProviderHttpFixture } from '../test-utils/provider-http-fixture.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ReadFileTool } from '../tools/read-file.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import type { AgentUnifiedTask } from '../tasks/unified-task.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { clearCommandQueue } from '../services/messageQueueManager.js';
import {
  getSubagentArtifactContext,
  readSubagentTranscript,
} from '../services/subagent-transcript.js';
import { readAgentTaskRecord } from './agent-task-runtime.js';
import { AgentRegistry } from './registry/agentRegistry.js';
import {
  parseAgentMarkdown,
  markdownToAgentDefinition,
} from './registry/agentLoader.js';
import { runLocalAgentInvocation } from './local-agent-runner.js';
import { resumeBackgroundAgentWithMessage } from './teams/agent-message-delivery.js';
import { wakeTeamMemberIfIdle } from './teams/agent-team-wakeup.js';
import {
  readAgentTeamConfig,
  upsertAgentTeamMember,
  sendTeamMessage,
} from './teams/agent-team-runtime.js';
import { AgentTerminateMode } from './types.js';
import { disposeSessionEventQueue } from './subagent-sdk-events.js';

it.each(['agent', 'teammate'] as const)(
  'E12: %s wakes with persisted B and the same transcript while the session uses A',
  async (kind) => {
    const fixture = await createProviderHttpFixture(undefined, true);
    const { config, manager, dir, requests } = fixture;
    const registry = new AgentRegistry(config);
    const tools = new ToolRegistry(config);
    tools.registerTool(new ReadFileTool(config));
    const tasks = new TaskRegistry();
    config.taskRegistry = tasks;
    const select = vi.spyOn(manager, 'select');
    vi.spyOn(config, 'getAgentRegistry').mockReturnValue(registry);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(tools);
    const context = {
      config,
      toolRegistry: tools,
      taskRegistry: tasks,
      agentDepth: 0,
      promptId: 'wake-prompt',
    } as AgentLoopContext;
    try {
      const file = join(dir, 'wake-probe.md');
      await writeFile(
        file,
        '---\nname: wake-probe\ndescription: Wake probe\nmodel: fixture/model-b\n---\nReply with the marker.\n',
      );
      const [parsed] = await parseAgentMarkdown(file);
      const registration = await registry.registerSdkAgents([
        markdownToAgentDefinition(parsed, { filePath: file }),
      ]);
      expect(registration.failed).toEqual([]);
      const definition = registry.getDefinition('wake-probe')!;
      expect(definition.kind).toBe('local');
      const first = await runLocalAgentInvocation({
        definition,
        context,
        agentArgs: { query: 'E12_ORIGINAL_HISTORY' },
        signal: new AbortController().signal,
        description: 'Wake probe',
        completionBehavior: 'silent',
        emitSdkSideEvents: false,
      });
      expect(first.terminateReason).toBe(AgentTerminateMode.GOAL);
      expect(requests.map((r) => r.model)).toEqual(['model-b']);
      expect(select.mock.calls[0][0].overrideSelection).toBeUndefined();
      const saved = await readAgentTaskRecord(
        getSubagentArtifactContext(config),
        config.getSessionId(),
        first.taskId,
      );
      expect(saved).toMatchObject({
        agentId: first.agentId,
        resolvedModel: 'fixture/model-b',
      });
      const before = await readSubagentTranscript(
        getSubagentArtifactContext(config),
        config.getSessionId(),
        first.agentId,
      );
      expect(JSON.stringify(before)).toContain('E12_ORIGINAL_HISTORY');

      // Change the current definition as well as the session anchor: B must
      // come from the saved task/member, not a second read of the same file.
      await registry.registerSdkAgents([
        { ...definition, modelConfig: { model: 'fixture/model-a' } },
      ]);
      manager.setMainModel((await manager.getModel('fixture/model-a'))!, false);
      if (kind === 'agent') {
        const recipient = tasks.get(`a-${first.agentId}`) as AgentUnifiedTask;
        expect(recipient.resolvedModel).toBe('fixture/model-b');
        const wake = await resumeBackgroundAgentWithMessage({
          context,
          recipient,
          message: 'E12_WAKE_MESSAGE',
          origin: { kind: 'human' },
        });
        expect(wake.agentId).toBe(first.agentId);
        expect(wake.taskId).not.toBe(first.taskId);
        await vi.waitFor(() =>
          expect(tasks.get(`a-${first.agentId}`)?.status).toBe('completed'),
        );
      } else {
        await upsertAgentTeamMember({
          teamName: 'wake-team',
          leadSessionId: config.getSessionId(),
          member: {
            name: 'worker',
            agentId: first.agentId,
            taskId: first.taskId,
            agentType: definition.name,
            resolvedModel: saved!.resolvedModel,
            sessionId: config.getSessionId(),
            status: 'idle',
          },
        });
        await sendTeamMessage({
          teamName: 'wake-team',
          from: 'team-lead',
          to: 'worker',
          text: 'E12_WAKE_MESSAGE',
        });
        const wake = await wakeTeamMemberIfIdle({
          context,
          teamName: 'wake-team',
          memberName: 'worker',
          senderName: 'team-lead',
          message: 'E12_WAKE_MESSAGE',
        });
        expect(wake).toMatchObject({ woken: true, agentId: first.agentId });
        expect(wake.taskId).not.toBe(first.taskId);
        await vi.waitFor(async () => {
          expect(
            (await readAgentTeamConfig('wake-team'))?.members.find(
              (member) => member.name === 'worker',
            )?.status,
          ).toBe('idle');
        });
      }
      expect(requests.map((r) => r.model)).toEqual(['model-b', 'model-b']);
      expect(select.mock.calls).toHaveLength(2);
      expect(select.mock.calls[1][0].overrideSelection).toBeUndefined();
      expect(JSON.stringify(requests[1].messages)).toContain(
        'E12_ORIGINAL_HISTORY',
      );
      expect(JSON.stringify(requests[1].messages)).toContain(
        'PROVIDER_HTTP_OK',
      );
      expect(JSON.stringify(requests[1].messages)).toContain(
        'E12_WAKE_MESSAGE',
      );
      const after = await readSubagentTranscript(
        getSubagentArtifactContext(config),
        config.getSessionId(),
        first.agentId,
      );
      expect(after!.messages.length).toBeGreaterThan(before!.messages.length);
      expect(tasks.get(`a-${first.agentId}`)).toMatchObject({
        agentId: first.agentId,
        resolvedModel: 'fixture/model-b',
      });
      expect(manager.getMainModelKey()).toBe('fixture/model-a');
    } finally {
      clearCommandQueue();
      disposeSessionEventQueue(config.getSessionId());
      tasks.clear();
      registry.dispose();
      await fixture.dispose();
    }
  },
  30000,
);
