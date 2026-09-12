/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalMode, Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { WorkflowTool } from '../tools/workflow/workflow.js';
import type { LlmClient } from './client.js';
import {
  CoreToolScheduler,
  type CompletedToolCall,
} from './coreToolScheduler.js';
import { LlmChat } from './llm-chat.js';

describe('workflow cancellation experience outcomes', () => {
  let directory: string;
  let config: Config;
  let client: LlmClient;
  let toolRegistry: ToolRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'workflow-experience-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(directory, 'runtime'));
    config = new Config({
      cwd: directory,
      targetDir: directory,
      model: 'test-model',
      approvalMode: ApprovalMode.YOLO,
      debugMode: false,
      chatRecording: false,
      usageStatisticsEnabled: false,
      telemetry: { enabled: false },
      disableAllHooks: true,
      overrideExtensions: [],
    });
    client = config.getLlmClient();
    client['chat'] = new LlmChat(config);
    toolRegistry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(toolRegistry);
  });

  afterEach(async () => {
    config.getWorkflowRunRegistry().abortAll();
    await toolRegistry.stop();
    await config.shutdown({ shutdownTelemetry: false });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['cancelled', 'failed'] as const)(
    'records only a genuine failure when a %s workflow is followed by success',
    async (firstOutcome) => {
      let releaseDispatch!: (value: string) => void;
      const dispatchResult = new Promise<string>((resolve) => {
        releaseDispatch = resolve;
      });
      const dispatch = vi.fn(async () => dispatchResult);
      toolRegistry.registerTool(new WorkflowTool(config, { dispatch }));
      const registry = config.getWorkflowRunRegistry();
      const completed = new Map<string, CompletedToolCall>();
      const scheduler = new CoreToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onAllToolCallsComplete: async (calls) => {
          client.recordCompletedToolCalls(
            calls.map((call) => ({
              toolName: call.request.name,
              args: call.request.args,
              outcome: {
                callId: call.request.callId,
                status: call.status,
                executionStatus: call.response.executionStatus,
                errorType: call.response.errorType,
                responseParts: call.response.responseParts,
              },
            })),
          );
          for (const call of calls) completed.set(call.request.callId, call);
        },
      });
      const outerSignal = new AbortController().signal;
      const schedule = async (callId: string, script: string) => {
        const args = { script };
        await client.addHistory({
          role: 'model',
          parts: [
            { functionCall: { id: callId, name: ToolNames.WORKFLOW, args } },
          ],
        });
        await scheduler.schedule(
          [
            {
              callId,
              name: ToolNames.WORKFLOW,
              args,
              isClientInitiated: false,
              prompt_id: callId,
            },
          ],
          outerSignal,
        );
      };
      const waitForCompletion = async (callId: string) => {
        await vi.waitFor(() => expect(completed.has(callId)).toBe(true));
        return completed.get(callId)!;
      };
      const accept = async (call: CompletedToolCall) => {
        await client.addHistory({
          role: 'user',
          parts: call.response.responseParts,
        });
        expect(client.getChat().getHistoryFunctionResponseIds()).toContain(
          call.request.callId,
        );
      };

      const firstScheduled = schedule(
        'first-workflow',
        firstOutcome === 'cancelled'
          ? "await agent('hold'); return 'done';"
          : "await agent('hold'); throw new Error('intentional workflow failure');",
      );
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(registry.list()).toHaveLength(1);
      const runId = registry.list()[0]!.runId;
      expect(registry.get(runId)?.status).toBe('running');
      if (firstOutcome === 'cancelled') registry.cancel(runId, Date.now());
      releaseDispatch('done');
      await firstScheduled;

      const first = await waitForCompletion('first-workflow');
      expect(outerSignal.aborted).toBe(false);
      expect(registry.get(runId)?.status).toBe(firstOutcome);
      expect(first.response.errorType).toBe(ToolErrorType.EXECUTION_FAILED);
      const failureCount = firstOutcome === 'failed' ? 1 : 0;
      expect(client['toolCallCount']).toBe(failureCount);
      expect(client['pendingExperienceOutcomes'].size).toBe(failureCount);
      expect(first.response.executionStatus).toBe(
        firstOutcome === 'cancelled' ? 'cancelled' : 'error',
      );
      expect(client['experienceSignalsSinceReview'].failedToolNames.size).toBe(
        0,
      );
      await accept(first);
      expect(client['pendingExperienceOutcomes'].size).toBe(0);
      expect(client['experienceSignalsSinceReview'].failedToolNames).toEqual(
        new Set(firstOutcome === 'failed' ? [ToolNames.WORKFLOW] : []),
      );
      expect(client['experienceSignalsSinceReview'].retryArc).toBe(false);

      await schedule('successful-workflow', "return 'success';");
      const success = await waitForCompletion('successful-workflow');
      expect(success.status).toBe('success');
      expect(success.response.executionStatus).toBe('success');
      expect(
        client['pendingExperienceOutcomes'].get('successful-workflow'),
      ).toEqual({
        toolName: ToolNames.WORKFLOW,
        outcome: 'success',
      });
      await accept(success);
      expect(client['toolCallCount']).toBe(failureCount + 1);
      expect(client['pendingExperienceOutcomes'].size).toBe(0);
      expect(client['experienceSignalsSinceReview'].failedToolNames.size).toBe(
        0,
      );
      expect(client['experienceSignalsSinceReview'].retryArc).toBe(
        firstOutcome === 'failed',
      );
    },
  );
});
