/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalMode,
  Config,
  CoreToolScheduler,
  LlmChat,
  SendMessageType,
  ToolConfirmationOutcome,
  ToolNames,
  ToolRegistry,
  type CompletedToolCall,
  type LlmClient,
} from '@qwen-code/qwen-code-core';
import { ShellTool } from '@qwen-code/qwen-code-core/tools/shell.js';
import { ShellExecutionService } from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import { runSkillReviewByAgent } from '@qwen-code/qwen-code-core/memory/skillReviewAgentPlanner.js';
import { toCompletedToolCallOutcome } from './completed-tool-call-outcome.js';

vi.mock(
  '@qwen-code/qwen-code-core/memory/skillReviewAgentPlanner.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/memory/skillReviewAgentPlanner.js')
    >()),
    runSkillReviewByAgent: vi.fn(),
  }),
);

describe('shell experience completion pipeline', () => {
  let directory: string;
  let config: Config;
  let client: LlmClient;
  let registry: ToolRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'shell-experience-'));
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
      fileReadCacheDisabled: true,
    });
    client = config.getLlmClient();
    client['chat'] = new LlmChat(config);
    registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    vi.spyOn(config, 'getAutoSkillEnabled').mockReturnValue(true);
    vi.spyOn(config, 'getAutoSkillConfirmEnabled').mockReturnValue(false);
    vi.mocked(runSkillReviewByAgent).mockResolvedValue({
      touchedSkillFiles: [],
    });
  });

  afterEach(async () => {
    await config.getMemoryManager().drain();
    await registry.stop();
    await config.shutdown({ shutdownTelemetry: false });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a real signal-terminated child when cancellation arrives after exit',
    async () => {
      vi.spyOn(config, 'getShouldUseNodePtyShell').mockReturnValue(false);
      registry.registerTool(new ShellTool(config));
      const controller = new AbortController();
      const execute = ShellExecutionService.execute.bind(ShellExecutionService);
      vi.spyOn(ShellExecutionService, 'execute').mockImplementation(
        async (...args) => {
          const handle = await execute(...args);
          return {
            ...handle,
            result: handle.result.then((result) => {
              expect(result).toMatchObject({
                exitCode: null,
                signal: 15,
                aborted: false,
              });
              controller.abort();
              return result;
            }),
          };
        },
      );
      let completed: CompletedToolCall | undefined;
      const scheduler = new CoreToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onAllToolCallsComplete: async (calls) => {
          completed = calls[0];
          client.recordCompletedToolCall(
            completed.request.name,
            completed.request.args,
            toCompletedToolCallOutcome(
              completed.request.callId,
              completed.status,
              completed.response,
            ),
          );
        },
      });
      await scheduler.schedule(
        [
          {
            callId: 'signal-exit',
            name: ToolNames.SHELL,
            args: {
              command: 'printf landed > artifact.txt; kill -TERM $$',
              directory,
              is_background: false,
            },
            isClientInitiated: false,
            prompt_id: 'signal-exit',
          },
        ],
        controller.signal,
      );
      await vi.waitFor(() => expect(completed).toBeDefined());
      expect(await readFile(path.join(directory, 'artifact.txt'), 'utf8')).toBe(
        'landed',
      );
      expect(completed!.status).toBe('cancelled');
      expect(completed!.response.executionStatus).toBe('error');
      expect(JSON.stringify(completed!.response.responseParts)).toContain(
        'The tool had already completed',
      );
      expect(client['toolCallCount']).toBe(1);
      expect(client['pendingExperienceOutcomes'].size).toBe(0);
    },
  );

  it.each(['sed', 'foreground'] as const)(
    'schedules one review after five calls with a recovered %s failure',
    async (mode) => {
      await writeFile(path.join(directory, 'file.txt'), 'foo\n');
      const shell = new ShellTool(config);
      registry.registerTool(shell);
      const completed = new Map<string, CompletedToolCall>();
      const scheduler = new CoreToolScheduler({
        config,
        getPreferredEditor: () => undefined,
        onEditorClose: () => {},
        onAllToolCallsComplete: async (calls) => {
          for (const call of calls) {
            client.recordCompletedToolCall(
              call.request.name,
              call.request.args,
              toCompletedToolCallOutcome(
                call.request.callId,
                call.status,
                call.response,
              ),
            );
            completed.set(call.request.callId, call);
          }
        },
      });
      if (mode === 'sed') {
        vi.spyOn(
          config.getFileSystemService(),
          'writeTextFile',
        ).mockRejectedValueOnce(
          Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
        );
      }
      const executeProcess = vi.spyOn(ShellExecutionService, 'execute');
      for (let index = 0; index < 5; index++) {
        const callId = `shell-${index}`;
        const args = {
          command: mode === 'sed' ? "sed -i 's/foo/bar/' file.txt" : 'npm test',
          directory,
          is_background: false,
        };
        const signal = new AbortController().signal;
        if (mode === 'sed') {
          const invocation = shell.build(args);
          const details = await invocation.getConfirmationDetails(signal);
          expect(details.type).toBe('edit');
          await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
          vi.spyOn(shell, 'build').mockReturnValueOnce(invocation);
        } else {
          executeProcess.mockResolvedValueOnce({
            pid: undefined,
            result: Promise.resolve({
              rawOutput: Buffer.from('test output'),
              output: 'test output',
              exitCode: index === 0 ? 3 : 0,
              signal: null,
              error: null,
              aborted: false,
              pid: undefined,
              executionMethod: 'child_process',
            }),
          });
        }
        await client.addHistory({
          role: 'model',
          parts: [
            { functionCall: { id: callId, name: ToolNames.SHELL, args } },
          ],
        });
        await scheduler.schedule(
          [
            {
              callId,
              name: ToolNames.SHELL,
              args,
              isClientInitiated: false,
              prompt_id: callId,
            },
          ],
          signal,
        );
        await vi.waitFor(() => expect(completed.has(callId)).toBe(true));
        const call = completed.get(callId)!;
        expect(call.status).toBe(index === 0 ? 'error' : 'success');
        if (index > 0) expect(call.response.exitCode).toBe(0);
        await client.addHistory({
          role: 'user',
          parts: call.response.responseParts,
        });
        expect(client['experienceSignalsSinceReview'].retryArc).toBe(index > 0);
        client['runManagedAutoMemoryBackgroundTasks'](
          SendMessageType.ToolResult,
        );
        await config.getMemoryManager().drain();
        expect(runSkillReviewByAgent).toHaveBeenCalledTimes(
          index === 4 ? 1 : 0,
        );
      }
      if (mode === 'sed') {
        expect(executeProcess).not.toHaveBeenCalled();
        expect(await readFile(path.join(directory, 'file.txt'), 'utf8')).toBe(
          'bar\n',
        );
      }
      expect(client['toolCallCount']).toBe(0);
      expect(client['experienceSignalsSinceReview'].retryArc).toBe(false);
      client['runManagedAutoMemoryBackgroundTasks'](SendMessageType.ToolResult);
      await config.getMemoryManager().drain();
      expect(runSkillReviewByAgent).toHaveBeenCalledOnce();
    },
  );
});
