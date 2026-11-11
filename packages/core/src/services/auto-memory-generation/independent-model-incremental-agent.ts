/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { systemPromptFromText } from '../../prompts/system-prompt.js';
import { directoryPermissionPattern } from '../../tools/filesystem-permissions/pathRules.js';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config/config.js';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import {
  buildIndependentIncrementalMemoryDirective,
  type MemoryExtractionRoot,
  type PreviousGeneratedMemory,
} from '../../agents/memory-extraction-agent.js';
import { buildSubagentRegistries } from '../../agents/agent-setup.js';
import {
  runSubagent,
  type RunSubagentResult,
} from '../../agents/run-subagent.js';
import type { LocalAgentDefinition } from '../../agents/types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';

import { buildAutoApproveAgentContext } from '../../agents/agent-context-factory.js';
import { createAgentId } from '../../utils/agentId.js';
import { isAbortError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../../tools/tool-names.js';
import {
  CoreToolCallStatus,
  type CompletedToolCall,
} from '../../tool-executor/types.js';
import {
  ensureAutoMemoryDir,
  getMemoryIndexPath,
  getScopedAutoMemoryDirs,
  listMemoryFileNames,
  MEMORY_INDEX_FILENAME,
  type ScopedAutoMemoryDir,
} from '../../memory/structured-memory-store.js';
import { loadMemoryIndex } from '../../memory/memory-index.js';
import { buildPermissionContext } from '../../agents/agent-context-factory.js';
import { buildForkCheckerMap } from '../../tools/tool-checkers/fork-restrictions.js';
import type { PermissionContext } from '../../permissions/manager/types.js';

import { ExecutionLifecycleService } from '../executionLifecycleService.js';
import { snapshotCustomContext } from '../../utils/sessionIdContext.js';
import type { SessionStateStore } from '../session-state-store.js';
import type { AutoMemoryTurnContext } from '../autoMemoryExtractionService.js';
import type { NonNullableUsage } from '../../protocol/schemas/common.js';
import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import { addAnthropicUsage } from '../../protocol/provider/usage-converter.js';

import type {
  ModelRequestCompletedSnapshot,
  ModelRequestFinishedSnapshot,
} from '../../model-request/types.js';
import type { InternalAgentUnifiedTask } from '../../tasks/unified-task.js';
import {
  createTaskStartedEvent,
  enqueueBackgroundTasksChangedFromRegistry,
  enqueueSubagentSdkEvent,
} from '../../agents/subagent-sdk-events.js';
import {
  commitAutoMemoryIncrementalState,
  getCapturedEndpointUuid,
  getMessagesAfterCommittedCursor,
  loadAutoMemoryIncrementalState,
} from './incremental-state.js';

const AGENT_NAME = 'auto-memory-incremental';
const AGENT_DESCRIPTION = 'Incremental memory extraction';
const MAX_TURNS = 5;
const MAX_RETRIES = 3;
const ALLOWED_TOOLS = [
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
];

const SYSTEM_PROMPT = [
  'You are an independent memory extraction agent.',
  'Use only the supplied incremental transcript messages and the previous generated-memory snapshot as conversation evidence.',
  'You may use Read, Write, and Edit only inside the explicitly listed memory roots.',
  'Finish after updating durable memories; do not perform unrelated work.',
].join('\n');

export interface IndependentModelIncrementalMemoryAgentOptions {
  config: Config;
  sessionStateStore: SessionStateStore;
  /** Fixed model selected by the session strategy (normally from QCS). */
  model: string;
  onResult?: IndependentModelIncrementalMemoryResultCallback;
}

export type IndependentModelIncrementalMemoryResultCallback = (
  result: IndependentModelIncrementalMemoryResult,
) => void | Promise<void>;

export interface IndependentModelIncrementalMemoryWriteStats {
  successfulPaths: string[];
  attemptCount: number;
  successCount: number;
  failedCount: number;
  failures: Array<{
    toolCallId: string;
    toolName: string;
    errorClass: string;
    filePath?: string;
  }>;
}

export interface IndependentModelIncrementalMemoryResult {
  status: 'completed' | 'failed' | 'stopped';
  taskId: string;
  model: string;
  committedMessageUuid?: string;
  incrementalMessageCount: number;
  writtenPaths: string[];
  modelRequestIds: string[];
  modelRequests: ModelRequestCompletedSnapshot[];
  modelRequestResults: ModelRequestFinishedSnapshot[];
  totalUsage: NonNullableUsage;
  credits?: number;
  durationMs: number;
  writeStats: IndependentModelIncrementalMemoryWriteStats;
  error?: string;
}

interface CapturedTurn extends AutoMemoryTurnContext {
  messages: AutoMemoryTurnContext['messages'];
  onResult?: IndependentModelIncrementalMemoryResultCallback;
}

/**
 * A-group executor: fixed-model, independent, incremental and non-blocking.
 * Calls are coalesced while one extraction is running; the next run always
 * uses the latest captured active lineage and the last encrypted commit.
 */
export class IndependentModelIncrementalMemoryAgent {
  private pendingTurn: CapturedTurn | undefined;
  private pumpPromise: Promise<void> | undefined;

  constructor(
    private readonly options: IndependentModelIncrementalMemoryAgentOptions,
  ) {}

  schedule(
    turn: AutoMemoryTurnContext,
    onResult?: IndependentModelIncrementalMemoryResultCallback,
  ): void {
    this.pendingTurn = {
      ...turn,
      messages: [...turn.messages],
      onResult,
    };
    if (!this.pumpPromise) {
      this.pumpPromise = this.pump().finally(() => {
        this.pumpPromise = undefined;
        if (this.pendingTurn) this.schedule(this.pendingTurn);
      });
    }
  }

  async drain(): Promise<void> {
    while (this.pumpPromise || this.pendingTurn) {
      await this.pumpPromise;
    }
  }

  private async pump(): Promise<void> {
    while (this.pendingTurn) {
      const turn = this.pendingTurn;
      this.pendingTurn = undefined;
      try {
        await this.maybeRun(turn);
      } catch (error) {
        runLogger.warn(
          '[AutoMemoryIncremental] background extraction failed:',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }

  private async maybeRun(turn: CapturedTurn): Promise<void> {
    if (this.options.config.isPlanMode?.()) return;

    const endpointUuid = getCapturedEndpointUuid(turn.messages);
    if (!endpointUuid) return;

    const state = await loadAutoMemoryIncrementalState(
      this.options.sessionStateStore,
    );
    const incrementalMessages = getMessagesAfterCommittedCursor(
      turn.messages,
      state.committed_message_uuid,
    );

    const scopedRoots = getScopedAutoMemoryDirs(this.options.config);
    if (scopedRoots.length === 0) return;
    await Promise.all(scopedRoots.map(({ dir }) => ensureAutoMemoryDir(dir)));

    const previousGeneratedMemories = state.previous_generated_memories.filter(
      ({ filePath }) => isInsideRoots(filePath, scopedRoots),
    );
    const roots: MemoryExtractionRoot[] = await Promise.all(
      scopedRoots.map(async ({ scope, dir }) => {
        const [index, files] = await Promise.all([
          loadMemoryIndex(getMemoryIndexPath(dir)),
          listMemoryFileNames(dir),
        ]);
        return { scope, dir, index, files };
      }),
    );
    const directive = buildIndependentIncrementalMemoryDirective(
      roots,
      incrementalMessages.length,
      previousGeneratedMemories,
    );

    await this.runBackgroundTask({
      turn,
      endpointUuid,
      incrementalMessages,
      previousGeneratedMemories,
      scopedRoots,
      directive,
    });
  }

  private async runBackgroundTask(params: {
    turn: CapturedTurn;
    endpointUuid: string;
    incrementalMessages: AutoMemoryTurnContext['messages'];
    previousGeneratedMemories: PreviousGeneratedMemory[];
    scopedRoots: ScopedAutoMemoryDir[];
    directive: string;
  }): Promise<void> {
    const { config } = this.options;
    const sessionId = config.getSessionId();
    const agentId = createAgentId(AGENT_NAME);
    const publicTaskId = createAgentId('memory');
    const taskId = `i-${agentId}`;
    const abortController = new AbortController();
    const settlement: { promise?: Promise<void> } = {};
    const lifecycle = ExecutionLifecycleService.createExecution(
      '',
      async () => {
        abortController.abort('task_stop');
        await settlement.promise;
      },
      'none',
      undefined,
      AGENT_DESCRIPTION,
      'silent',
      {
        taskId: publicTaskId,
        sessionId,
        customContext: snapshotCustomContext(params.turn.customContext),
      },
    );
    const executionId = lifecycle.pid;
    if (executionId === undefined) {
      throw new Error('Failed to allocate an incremental memory execution ID');
    }

    const taskRegistry = config.taskRegistry;
    if (!taskRegistry) {
      ExecutionLifecycleService.completeExecution(executionId, {
        exitCode: 1,
        error: new Error('Task registry is unavailable'),
      });
      throw new Error('Task registry is required for incremental memory tasks');
    }
    const task: InternalAgentUnifiedTask = {
      id: taskId,
      publicId: publicTaskId,
      sessionId,
      type: 'internal_agent',
      status: 'running',
      description: AGENT_DESCRIPTION,
      startTime: Date.now(),
      notified: true,
      executionId,
      completionBehavior: 'silent',
      agentName: AGENT_NAME,
      agentType: 'memory',
      prompt: AGENT_DESCRIPTION,
      phase: 'extracting',
      isBackgrounded: true,
      killable: true,
    };
    taskRegistry.register(task);
    enqueueSubagentSdkEvent(
      sessionId,
      createTaskStartedEvent({
        sessionId,
        taskId: publicTaskId,
        description: AGENT_DESCRIPTION,
        taskType: 'internal_agent',
        subagentType: 'memory',
        tools: [...ALLOWED_TOOLS],
      }),
    );
    enqueueBackgroundTasksChangedFromRegistry(sessionId, taskRegistry);
    ExecutionLifecycleService.background(executionId, 'auto');

    const run = this.executeAgent({
      ...params,
      agentId,
      abortController,
    });
    settlement.promise = run;
    await run;
  }

  private async executeAgent(params: {
    turn: CapturedTurn;
    endpointUuid: string;
    incrementalMessages: AutoMemoryTurnContext['messages'];
    previousGeneratedMemories: PreviousGeneratedMemory[];
    scopedRoots: ScopedAutoMemoryDir[];
    directive: string;
    agentId: string;
    abortController: AbortController;
  }): Promise<void> {
    const { config, model, sessionStateStore } = this.options;
    const sessionId = config.getSessionId();
    const taskRegistry = config.taskRegistry;
    if (!taskRegistry) {
      throw new Error('Task registry is required for incremental memory tasks');
    }
    const task = taskRegistry
      .all()
      .find(
        (candidate) =>
          candidate.type === 'internal_agent' &&
          candidate.agentName === AGENT_NAME &&
          candidate.status === 'running' &&
          candidate.id === `i-${params.agentId}`,
      );
    if (!task || task.type !== 'internal_agent') {
      throw new Error('Incremental memory task registration was lost');
    }

    const startedAtMs = Date.now();
    const successfulWritePaths = new Set<string>();
    let writeAttemptCount = 0;
    let writeSuccessCount = 0;
    let writeFailedCount = 0;
    const writeFailures: IndependentModelIncrementalMemoryWriteStats['failures'] =
      [];
    const onCompletedToolCall = (call: CompletedToolCall): void => {
      if (
        call.request.name !== WRITE_FILE_TOOL_NAME &&
        call.request.name !== EDIT_TOOL_NAME
      ) {
        return;
      }
      writeAttemptCount += 1;
      const filePath = call.request.args['file_path'];
      const absolutePath =
        typeof filePath === 'string'
          ? path.resolve(config.getWorkingDir(), filePath)
          : undefined;
      if (
        call.status !== CoreToolCallStatus.Success ||
        call.response.isError === true
      ) {
        writeFailedCount += 1;
        writeFailures.push({
          toolCallId: call.request.callId,
          toolName: call.request.name,
          errorClass:
            call.response.errorType ??
            (call.status === CoreToolCallStatus.Cancelled
              ? 'cancelled'
              : 'tool_result_error'),
          ...(absolutePath ? { filePath: absolutePath } : {}),
        });
        return;
      }
      if (!absolutePath || !isInsideRoots(absolutePath, params.scopedRoots)) {
        return;
      }
      writeSuccessCount += 1;
      successfulWritePaths.add(absolutePath);
    };

    const modelRequestIds = new Set<string>();
    const modelRequestsById = new Map<string, ModelRequestCompletedSnapshot>();
    const modelRequestResultsById = new Map<
      string,
      ModelRequestFinishedSnapshot
    >();
    let totalUsage = cloneUsage();
    let credits: number | undefined;
    const collectRunResult = (result: RunSubagentResult): void => {
      for (const requestId of result.modelRequestIds ?? []) {
        modelRequestIds.add(requestId);
      }
      for (const request of result.modelRequests ?? []) {
        modelRequestIds.add(request.requestId);
        modelRequestsById.set(request.requestId, request);
      }
      for (const requestResult of result.modelRequestResults ?? []) {
        modelRequestIds.add(requestResult.requestId);
        modelRequestResultsById.set(requestResult.requestId, requestResult);
      }
      totalUsage = addAnthropicUsage(totalUsage, result.totalUsage);
      if (result.credits !== undefined) {
        credits = (credits ?? 0) + result.credits;
      }
    };
    const buildResult = (
      status: IndependentModelIncrementalMemoryResult['status'],
      error?: string,
    ): IndependentModelIncrementalMemoryResult => ({
      status,
      taskId: task.publicId ?? task.id,
      model,
      ...(status === 'completed'
        ? { committedMessageUuid: params.endpointUuid }
        : {}),
      incrementalMessageCount: params.incrementalMessages.length,
      writtenPaths: [...successfulWritePaths],
      modelRequestIds: [...modelRequestIds],
      modelRequests: [...modelRequestsById.values()],
      modelRequestResults: [...modelRequestResultsById.values()],
      totalUsage,
      ...(credits !== undefined ? { credits } : {}),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      writeStats: {
        successfulPaths: [...successfulWritePaths],
        attemptCount: writeAttemptCount,
        successCount: writeSuccessCount,
        failedCount: writeFailedCount,
        failures: writeFailures,
      },
      ...(error ? { error } : {}),
    });

    try {
      const runAttempt = async (): Promise<void> => {
        let toolRegistry: ToolRegistry | undefined;
        let scene: string | undefined;
        try {
          const definition = createDefinition(model);
          const parentContext = createParentContext(config);
          const promptId = `auto-memory-incremental-${randomUUID().slice(0, 8)}`;
          const registries = await buildSubagentRegistries(
            definition,
            parentContext,
            promptId,
            {
              agentId: params.agentId,
              isBackground: true,
              subscribeMcpProgress: false,
              onCompletedToolCall,
            },
          );
          scene = `fork:independent-memory:${randomUUID().slice(0, 8)}`;
          config.getProcessPermissionManager()?.registerSceneCheckers(
            scene,
            buildForkCheckerMap({
              readWriteDirectories: params.scopedRoots.map(({ dir }) => dir),
              label: scene,
            }),
          );
          (
            registries.schedulerContext as {
              permissionContext?: () => PermissionContext | undefined;
            }
          ).permissionContext = createMemoryPermissionOverride(
            params.scopedRoots,
            scene,
          );
          toolRegistry = registries.toolRegistry;

          const result = await runSubagent({
            definition,
            agentId: params.agentId,
            prompt: params.directive,
            contextMessages: params.incrementalMessages,
            systemPrompt: systemPromptFromText(SYSTEM_PROMPT),
            model,
            promptId,
            context: parentContext,
            toolRegistry,
            toolExecutor: config.getToolExecutor(),
            schedulerContext: registries.schedulerContext,
            forkContext: registries.forkContext,
            maxTurns: MAX_TURNS,
            signal: params.abortController.signal,
            sessionId,
            customContext: params.turn.customContext,
            parentRequestSetId: params.turn.parentRequestSetId,
            parentBusinessInfo: params.turn.parentBusinessInfo,
            disableCompression: true,
            inheritParentReasoning: false,
            querySource: 'auto_memory',
          });
          collectRunResult(result);

          const terminalReason = result.terminal?.reason;
          if (
            terminalReason === 'end_turn' ||
            (terminalReason === 'max_turns' && successfulWritePaths.size > 0)
          ) {
            return;
          }
          throw (
            result.terminal?.error ??
            new Error(
              `Incremental memory agent ended with ${terminalReason ?? 'unknown status'}`,
            )
          );
        } finally {
          if (scene) {
            config
              .getProcessPermissionManager()
              ?.unregisterSceneCheckers(scene);
          }
          toolRegistry?.dispose();
        }
      };

      for (let attempt = 0; ; attempt += 1) {
        try {
          await runAttempt();
          break;
        } catch (error) {
          if (
            params.abortController.signal.aborted ||
            isAbortError(error) ||
            attempt >= MAX_RETRIES
          ) {
            throw error;
          }
          runLogger.warn('[AutoMemoryIncremental] retrying failed attempt', {
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            model,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const writtenPaths = [...successfulWritePaths];
      const contentPaths = writtenPaths.filter(
        (filePath) => path.basename(filePath) !== MEMORY_INDEX_FILENAME,
      );
      const nextPreviousGeneratedMemories =
        contentPaths.length > 0
          ? mergeGeneratedMemorySnapshots(
              params.previousGeneratedMemories,
              await snapshotGeneratedMemories(contentPaths),
            )
          : params.previousGeneratedMemories;
      await commitAutoMemoryIncrementalState(sessionStateStore, {
        committed_message_uuid: params.endpointUuid,
        previous_generated_memories: nextPreviousGeneratedMemories,
      });

      const summary =
        writtenPaths.length > 0
          ? `Saved ${writtenPaths.length} memory change${writtenPaths.length === 1 ? '' : 's'}.`
          : 'No durable memory changes were needed.';
      ExecutionLifecycleService.appendOutput(task.executionId, summary);
      taskRegistry.update(task.id, {
        status: 'completed',
        endTime: Date.now(),
        phase: 'completed',
        result: summary,
      });
      ExecutionLifecycleService.completeExecution(task.executionId, {
        exitCode: 0,
      });
      taskRegistry.markNotified(task.id);
      enqueueBackgroundTasksChangedFromRegistry(sessionId, taskRegistry);
      await this.notifyResult(params.turn, buildResult('completed'));
    } catch (error) {
      const stopped =
        params.abortController.signal.aborted || isAbortError(error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const currentTask = taskRegistry.get(task.id);
      if (currentTask?.status === 'running') {
        taskRegistry.update(task.id, {
          status: stopped ? 'killed' : 'failed',
          endTime: Date.now(),
          phase: stopped ? 'stopped' : 'failed',
          error: errorMessage,
        });
        ExecutionLifecycleService.completeExecution(task.executionId, {
          aborted: stopped,
          exitCode: stopped ? 130 : 1,
          error: stopped
            ? null
            : error instanceof Error
              ? error
              : new Error(errorMessage),
        });
        taskRegistry.markNotified(task.id);
        enqueueBackgroundTasksChangedFromRegistry(sessionId, taskRegistry);
      }
      await this.notifyResult(
        params.turn,
        buildResult(stopped ? 'stopped' : 'failed', errorMessage),
      );
    }
  }

  private async notifyResult(
    turn: CapturedTurn,
    result: IndependentModelIncrementalMemoryResult,
  ): Promise<void> {
    for (const callback of [this.options.onResult, turn.onResult]) {
      if (!callback) continue;
      try {
        await callback(result);
      } catch (error) {
        runLogger.warn('[AutoMemoryIncremental] result callback failed:', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function createDefinition(model: string): LocalAgentDefinition {
  return {
    kind: 'local',
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    promptConfig: { systemPrompt: SYSTEM_PROMPT },
    modelConfig: { model },
    toolConfig: { tools: [...ALLOWED_TOOLS] },
    permissionMode: 'auto',
    omitAgentsMd: true,
  };
}

function createParentContext(config: Config): AgentLoopContext {
  return {
    ...buildAutoApproveAgentContext(config, AGENT_NAME, []),
    taskRegistry: config.taskRegistry,
  };
}

function createMemoryPermissionOverride(
  roots: readonly ScopedAutoMemoryDir[],
  scene: string,
): () => PermissionContext {
  // Content rules the read/write checkers match against: they grant the
  // in-root paths directly, exactly like the old alwaysAllowRules did.
  const allowPatterns = roots.flatMap(({ dir }) => {
    const pattern = directoryPermissionPattern(dir);
    return [`Read(${pattern})`, `Edit(${pattern})`, `Write(${pattern})`];
  });
  const base = buildPermissionContext(ALLOWED_TOOLS);
  return () => ({
    ...base,
    rules: { allow: { session: allowPatterns }, deny: {}, ask: {} },
    // The confinement the old restrictFileAccessToSdkMemoryRoots flag
    // expressed: a fork table whose entries refuse anything outside the roots.
    scene,
  });
}

function isInsideRoots(
  filePath: string,
  roots: ReadonlyArray<Pick<ScopedAutoMemoryDir, 'dir'>>,
): boolean {
  return roots.some(({ dir }) => {
    const relative = path.relative(dir, filePath);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  });
}

async function snapshotGeneratedMemories(
  filePaths: readonly string[],
): Promise<PreviousGeneratedMemory[]> {
  return Promise.all(
    [...new Set(filePaths)].map(async (filePath) => ({
      filePath,
      content: await readFile(filePath, 'utf8'),
    })),
  );
}

function mergeGeneratedMemorySnapshots(
  previous: readonly PreviousGeneratedMemory[],
  updated: readonly PreviousGeneratedMemory[],
): PreviousGeneratedMemory[] {
  const byPath = new Map(previous.map((memory) => [memory.filePath, memory]));
  for (const memory of updated) byPath.set(memory.filePath, memory);
  return [...byPath.values()];
}
