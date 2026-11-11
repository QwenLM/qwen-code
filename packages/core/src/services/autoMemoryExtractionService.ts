/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Auto-memory extraction orchestration service.
 *
 * Runs a background fork subagent after each conversation turn via
 * `runForkedAgent()` — the same `query()` code path used by compression
 * and subagent invocations. The fork inherits the parent system prompt
 * and message history for prompt-cache alignment.
 *
 * Tool scoping: tools are dispatched through the agent-scoped schema registry
 * that binds the parent's ToolRegistry + a fork-local permission context (allow
 * Read/Grep/Glob/Edit/Write only). The bridge is constructed with
 * `subscribeMcpProgress: false` so background forks do not accumulate
 * listeners on the global coreEvents emitter.
 */

import type { SystemPrompt } from '../prompts/types.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import {
  createConversationMessageAccessors,
  type AgentLoopContext,
} from '../config/agent-loop-context.js';
import {
  buildMemoryExtractionDirective,
  type MemoryExtractionRoot,
} from '../agents/memory-extraction-agent.js';
import {
  runForkedAgent,
  type ForkedAgentCompletion,
} from '../core/forkedAgent.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import { buildForkContextMessages } from '../utils/forkContextUtils.js';
import { directoryPermissionPattern } from '../tools/filesystem-permissions/pathRules.js';
import { buildModelProjectionOptions } from '../utils/modelProjectionOptions.js';
import { runLogger } from '../utils/runLogger.js';
import { isSDKMode } from '../utils/headless.js';
import {
  getKnownAutoMemoryDirs,
  getScopedAutoMemoryDirs,
  ensureAutoMemoryDir,
  listMemoryFileNames,
  getMemoryIndexPath,
  MEMORY_INDEX_FILENAME,
} from '../memory/structured-memory-store.js';
import { loadMemoryIndex } from '../memory/memory-index.js';
import type {
  Message as TranscriptMessage,
  AssistantMessage,
  Message,
  UserMessage,
} from '../protocol/transcript/message.js';
import {
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
} from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  CoreToolCallStatus,
  type CompletedToolCall,
} from '../tool-executor/types.js';

import { wrapWithParentToolSchemas } from '../agents/fork-subagent.js';
import { buildPermissionContext } from '../agents/agent-context-factory.js';
import type { PermissionContext } from '../permissions/manager/types.js';

import { getForkCompletionBilling } from '../model-request/credit-usage.js';
import {
  getAutoMemoryExtractionEveryNTurns,
  isAutoMemoryTurnCompleteGenerationEnabled,
} from '../config-service/features/autoMemoryPolicy.js';
import { SessionStateStore } from './session-state-store.js';
import { IndependentModelIncrementalMemoryAgent } from './auto-memory-generation/independent-model-incremental-agent.js';
import {
  AutoMemoryGenerationStrategySession,
  type AutoMemoryGenerationSelection,
} from './auto-memory-generation/strategy-selection.js';

/** Tools the memory-extraction fork is allowed to execute. */
const MEMORY_FORK_ALLOWED_TOOLS: string[] = [
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
];

/** One completed user turn plus full transcript state for a fork extraction. */
export interface AutoMemoryTurnContext {
  prompt: string;
  response: string;
  messages: TranscriptMessage[];
  systemPrompt: SystemPrompt;
  /** Parent agent's requestSetId — explicitly threaded to avoid AsyncLocalStorage boundary loss. */
  parentRequestSetId?: string;
  /** Parent assistant model request id that triggered this extraction. */
  parentRequestId?: string;
  /** 触发本次抽取的轮次上下文，由上游边界提供只读快照。 */
  customContext?: Readonly<Record<string, string>>;
  /** Parent agent's BusinessInfo — explicitly threaded for subagent lifecycle inheritance. */
  parentBusinessInfo?: Readonly<
    import('../qoder/business-info.js').BusinessInfo
  >;
  /** The SDK host callback already made the final cadence decision. */
  skipExtractionIntervalGate?: boolean;
}

type PendingContext = AutoMemoryTurnContext & {
  /** Parent request state captured when this turn completed. */
  cacheSafeQuerySnapshot?: CacheSafeQuerySnapshot;
};
type MemoryWriteOrigin =
  | 'main_session'
  | 'auto_fork'
  | 'auto_independent_agent'
  | 'mixed'
  | 'none';

interface AutoMemoryWriteStats {
  successfulPaths: string[];
  attemptCount: number;
  successCount: number;
  failedCount: number;
  failures: AutoMemoryWriteFailure[];
}

interface AutoMemoryWriteFailure {
  toolCallId: string;
  toolName: string;
  errorClass: string;
  filePath?: string;
}

function getMessagesSinceCursor(
  messages: readonly TranscriptMessage[],
  lastProcessedUuid: string | null,
): TranscriptMessage[] {
  if (!lastProcessedUuid) {
    return [...messages];
  }

  const lastProcessedIndex = messages.findIndex(
    (message) => message.uuid === lastProcessedUuid,
  );
  if (lastProcessedIndex === -1) {
    return [...messages];
  }

  return messages.slice(lastProcessedIndex + 1);
}

function countModelVisibleMessages(
  messages: readonly TranscriptMessage[],
): number {
  return messages.filter(
    (message) => message.type === 'user' || message.type === 'assistant',
  ).length;
}

function getAbsoluteToolPath(
  filePath: unknown,
  cwd: string,
): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return undefined;
  }

  return path.resolve(cwd, filePath);
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.type === 'assistant';
}

function isUserMessage(message: Message): message is UserMessage {
  return message.type === 'user';
}

/**
 * Collects Write/Edit attempts against auto-memory files and classifies them by
 * their matching tool_result. A tool_use is intent; only a non-error result is a
 * confirmed write.
 *
 * This is the single source of truth for "which memory files did these turns
 * touch?" — used both by the skip-guard (did the main agent already write this
 * turn?) and by the post-extraction counter (what did the fork itself produce?).
 */
function collectAutoMemoryWriteStats(
  messages: readonly TranscriptMessage[],
  autoMemoryDirs: readonly string[],
  cwd: string,
  failureByToolUseId: ReadonlyMap<string, AutoMemoryWriteFailure> = new Map(),
): AutoMemoryWriteStats {
  const resultSuccessByToolUseId = new Map<string, boolean>();
  const messageFailureByToolUseId = new Map<string, AutoMemoryWriteFailure>();
  for (const message of messages) {
    if (!isUserMessage(message) || !Array.isArray(message.message.content)) {
      continue;
    }
    const toolResultCount = message.message.content.filter(
      (block) => block.type === 'tool_result',
    ).length;
    let toolResultIndex = 0;
    for (const block of message.message.content) {
      if (block.type === 'tool_result') {
        const metadata =
          toolResultCount > 1 && Array.isArray(message.toolUseResult)
            ? message.toolUseResult[toolResultIndex]
            : message.toolUseResult;
        const denialKind = Array.isArray(message.toolDenialKind)
          ? message.toolDenialKind[toolResultIndex]
          : message.toolDenialKind;
        toolResultIndex++;
        resultSuccessByToolUseId.set(
          block.tool_use_id,
          block.is_error !== true,
        );
        if (block.is_error === true) {
          const metadataRecord =
            metadata !== null && typeof metadata === 'object'
              ? (metadata as Record<string, unknown>)
              : undefined;
          const errorType = metadataRecord?.['errorType'];
          const status = metadataRecord?.['status'];
          messageFailureByToolUseId.set(block.tool_use_id, {
            toolCallId: block.tool_use_id,
            toolName: 'unknown',
            errorClass:
              (typeof errorType === 'string' && errorType) ||
              (typeof status === 'string' && status) ||
              (denialKind ? `tool_denial_${denialKind}` : 'tool_result_error'),
          });
        }
      }
    }
  }

  const successfulPaths = new Set<string>();
  let attemptCount = 0;
  let successCount = 0;
  let failedCount = 0;
  const failures: AutoMemoryWriteFailure[] = [];

  for (const message of messages) {
    if (!isAssistantMessage(message)) {
      continue;
    }

    for (const block of message.message.content) {
      if (
        block.type !== 'tool_use' ||
        (block.name !== WRITE_FILE_TOOL_NAME && block.name !== EDIT_TOOL_NAME)
      ) {
        continue;
      }

      const filePath = getAbsoluteToolPath(
        (block.input as { file_path?: unknown })?.file_path,
        message.cwd ?? cwd,
      );
      if (!filePath) {
        continue;
      }

      if (!isPathInsideAnyDir(filePath, autoMemoryDirs)) {
        continue;
      }

      attemptCount++;
      if (resultSuccessByToolUseId.get(block.id) === true) {
        successCount++;
        successfulPaths.add(filePath);
      } else {
        failedCount++;
        const messageFailure = messageFailureByToolUseId.get(block.id);
        const failure =
          failureByToolUseId.get(block.id) ??
          (messageFailure
            ? { ...messageFailure, toolName: block.name }
            : {
                toolCallId: block.id,
                toolName: block.name,
                errorClass: resultSuccessByToolUseId.has(block.id)
                  ? 'tool_result_error'
                  : 'unknown_tool_failure',
              });
        failures.push({ ...failure, filePath });
      }
    }
  }

  return {
    successfulPaths: [...successfulPaths],
    attemptCount,
    successCount,
    failedCount,
    failures,
  };
}

function isPathInsideAnyDir(
  filePath: string,
  dirs: readonly string[],
): boolean {
  return dirs.some((dir) => {
    const relative = path.relative(dir, filePath);
    return (
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  });
}

function mergeAutoMemoryWriteStats(
  ...stats: Array<AutoMemoryWriteStats | undefined>
): AutoMemoryWriteStats {
  const successfulPaths = new Set<string>();
  let attemptCount = 0;
  let successCount = 0;
  let failedCount = 0;
  const failures: AutoMemoryWriteFailure[] = [];

  for (const stat of stats) {
    if (!stat) continue;
    attemptCount += stat.attemptCount;
    successCount += stat.successCount;
    failedCount += stat.failedCount;
    failures.push(...stat.failures);
    for (const filePath of stat.successfulPaths) {
      successfulPaths.add(filePath);
    }
  }

  return {
    successfulPaths: [...successfulPaths],
    attemptCount,
    successCount,
    failedCount,
    failures,
  };
}

function memoryWriteOrigin(params: {
  mainSessionAttempted: boolean;
  autoForkAttempted: boolean;
}): MemoryWriteOrigin {
  if (params.mainSessionAttempted && params.autoForkAttempted) return 'mixed';
  if (params.mainSessionAttempted) return 'main_session';
  if (params.autoForkAttempted) return 'auto_fork';
  return 'none';
}

function getLastAssistantRequestId(
  messages: readonly TranscriptMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === 'assistant' && message.requestId) {
      return message.requestId;
    }
  }
  return undefined;
}

function getErrorClass(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor.name || 'Error';
  }
  return typeof error;
}

/**
 * Builds a schema registry scoped to the memory-extraction fork's allowed tools.
 *
 * Inlined here (previously a session-level bridge in agent-context-factory)
 * because this is the sole caller. `subscribeMcpProgress: false` — background
 * forks have no UI surface for progress and subscribing would accumulate
 * listeners on the singleton coreEvents emitter.
 */
function buildMemoryForkBridge(
  config: Config,
  roots: readonly SdkAutoMemoryRoot[],
  onTerminalToolCall?: (call: CompletedToolCall) => void,
): { toolRegistry: ToolRegistry; agentContext: AgentLoopContext } {
  const promptId = `memory-fork-${randomUUID().slice(0, 8)}`;

  const toolRegistry = new ToolRegistry(config);

  const parentRegistry = config.getToolRegistry();
  for (const tool of parentRegistry.getAllTools()) {
    if (MEMORY_FORK_ALLOWED_TOOLS.includes(tool.name)) {
      toolRegistry.registerTool(tool.clone());
    }
  }
  toolRegistry.sortTools();

  const baseContext = buildPermissionContext(MEMORY_FORK_ALLOWED_TOOLS);
  const parentRules = config.permission?.getRules();
  const rootPatterns = roots.flatMap((root) => {
    const pattern = directoryPermissionPattern(root.dir);
    return root.access === 'read-write'
      ? [`Read(${pattern})`, `Edit(${pattern})`]
      : [`Read(${pattern})`];
  });

  // The parent's deny and ask rules come along: a rule the user wrote about a
  // path binds the fork too, and the fork must not become a way around it.
  const permissionContext: PermissionContext = {
    ...baseContext,
    rules: {
      allow: {
        session: [...(baseContext.rules?.allow.session ?? []), ...rootPatterns],
      },
      deny: { ...(parentRules?.deny ?? {}) },
      ask: { ...(parentRules?.ask ?? {}) },
    },
    // The roots are trusted directories for this fork; that is what keeps the
    // workspace-boundary check from asking about paths inside them.
    additionalDirectories: roots.map((root) => root.dir),
  };

  const context: AgentLoopContext = {
    config,
    promptId,
    toolRegistry,
    toolCallSnapshots: config.toolCallSnapshots,
    permission: config.permission,
    permissionContext: () => permissionContext,
    onCompletedToolCall: onTerminalToolCall,
    ...createConversationMessageAccessors(config),
  };

  return { toolRegistry, agentContext: context };
}

export interface AutoMemoryCallbacks {
  /**
   * Invoked once the service has decided to run a background memory fork for
   * the current turn. Skipped when the turn already wrote memory files itself.
   */
  onExtractionStarted?: () => void;
  /**
   * Invoked after a started background memory fork finishes, even when it
   * saves no files or fails. Lets the UI clear transient progress state.
   */
  onExtractionFinished?: (result?: AutoMemoryExtractionResult) => void;
  /**
   * Invoked after a background extraction that saved memories, with the absolute
   * paths of the topic files the fork wrote this run (the MEMORY.md index is
   * already excluded). The display layer derives its transient saved-item count
   * from this source of truth.
   */
  onMemoriesSaved?: (memoryPaths: string[]) => void;
  onMemoryRefresh?: () => void;
  onGenerationResult?: (result: AutoMemoryGenerationResult) => void;
}

export interface SdkAutoMemoryRoot {
  id: string;
  dir: string;
  access: 'read' | 'read-write';
  /** Relative path treated as this root's index. Omit when every file is content. */
  indexFile?: string;
}

export interface SdkAutoMemoryGenerationConfig {
  roots: SdkAutoMemoryRoot[];
  prompt: string;
}

export interface AutoMemoryGenerationResult {
  status: 'saved' | 'partial' | 'no_change' | 'skipped' | 'failed';
  attemptId: string;
  reason?: string;
  origin: 'main_session' | 'turn_complete';
  sourceRequestIds?: string[];
  modelRequestIds?: string[];
  writtenFiles: Array<{ rootId: string; path: string }>;
  failedFiles: Array<{
    rootId: string;
    path: string;
    error?: string;
  }>;
  indexUpdated?: boolean;
  contentUpdated?: boolean;
  durationMs: number;
  usage?: ForkedAgentCompletion['totalUsage'];
  credits?: number;
}

export type AutoMemoryExtractionResult =
  | { status: 'completed'; parentRequestSetId?: string }
  | { status: 'failed'; error: string; parentRequestSetId?: string };

/**
 * Orchestrates background memory extraction after each conversation turn.
 * Coalescing: if extraction is in progress, the latest context is stashed
 * and processed after the current run finishes (while loop, not recursion).
 */
export class AutoMemoryExtractionService {
  private inProgress = false;
  private pendingContext: PendingContext | null = null;
  private currentPromise: Promise<void> | null = null;
  private lastProcessedMessageUuid: string | null = null;
  private turnsSinceLastExtraction = 0;
  private readonly generationStrategySession =
    new AutoMemoryGenerationStrategySession();
  private independentIncrementalAgent?: IndependentModelIncrementalMemoryAgent;
  private readonly callbacks: AutoMemoryCallbacks;
  private sdkGenerationConfig?: SdkAutoMemoryGenerationConfig;

  constructor(
    private readonly config: Config,
    callbacks: AutoMemoryCallbacks = {},
  ) {
    this.callbacks = callbacks;
  }

  configureSdkGeneration(
    config: SdkAutoMemoryGenerationConfig | undefined,
  ): void {
    this.sdkGenerationConfig = config;
  }

  async onTurnComplete(ctx: AutoMemoryTurnContext): Promise<void> {
    const sdkControlled =
      isSDKMode() ||
      this.sdkGenerationConfig !== undefined ||
      this.config.isSdkMemoryRequestActive?.() === true;
    if (!sdkControlled && !isAutoMemoryTurnCompleteGenerationEnabled()) return;

    const cacheSafeQuerySnapshot = this.config.getCacheSafeQuerySnapshot?.();
    const pendingContext: PendingContext = cacheSafeQuerySnapshot
      ? {
          ...ctx,
          cacheSafeQuerySnapshot: {
            ...cacheSafeQuerySnapshot,
            forkContextMessages: [
              ...cacheSafeQuerySnapshot.forkContextMessages,
            ],
            toolSchemas: [...cacheSafeQuerySnapshot.toolSchemas],
          },
        }
      : ctx;

    if (this.inProgress) {
      this.pendingContext = pendingContext;
      return;
    }

    this.currentPromise = this.runExtractionLoop(pendingContext);
    await this.currentPromise;
  }

  async drain(timeoutMs?: number): Promise<void> {
    const drainPromise = Promise.all([
      this.currentPromise ?? Promise.resolve(),
      this.independentIncrementalAgent?.drain() ?? Promise.resolve(),
    ]).then(() => undefined);
    if (timeoutMs === undefined) {
      await drainPromise;
      return;
    }
    await Promise.race([
      drainPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private getOrCreateIndependentIncrementalAgent(
    selection: Extract<
      AutoMemoryGenerationSelection,
      { kind: 'independent_model_incremental' }
    >,
  ): IndependentModelIncrementalMemoryAgent {
    if (this.independentIncrementalAgent) {
      return this.independentIncrementalAgent;
    }
    const sessionStateStore = new SessionStateStore({
      projectRoot: this.config.getSessionArtifactProjectRoot(),
      sessionId: this.config.getSessionId(),
      persist: this.config.getSessionPersistence(),
    });
    runLogger.log('[AutoMemoryGeneration] selected A strategy', {
      model: selection.model,
    });
    this.independentIncrementalAgent =
      new IndependentModelIncrementalMemoryAgent({
        config: this.config,
        sessionStateStore,
        model: selection.model,
      });
    return this.independentIncrementalAgent;
  }

  private async runExtractionLoop(ctx: PendingContext): Promise<void> {
    this.inProgress = true;
    try {
      let current: PendingContext | null = ctx;
      let isTrailingRun = false;
      while (current) {
        try {
          await this.doExtraction(current, isTrailingRun);
        } catch (err) {
          runLogger.debug(
            '[AutoMemory] extraction error:',
            err instanceof Error ? err.message : String(err),
          );
        }
        current = this.pendingContext;
        this.pendingContext = null;
        isTrailingRun = current !== null;
      }
    } finally {
      this.inProgress = false;
      this.currentPromise = null;
    }
  }

  /**
   * Shared Turn Complete cadence for every Auto Memory generation strategy.
   * A trailing coalesced run and an SDK-approved turn bypass the interval,
   * matching the existing extraction behavior.
   */
  private shouldRunForTurnCompleteInterval(
    ctx: Pick<AutoMemoryTurnContext, 'skipExtractionIntervalGate'>,
    isTrailingRun: boolean,
  ): boolean {
    if (!isTrailingRun && !ctx.skipExtractionIntervalGate) {
      this.turnsSinceLastExtraction += 1;
      if (
        this.turnsSinceLastExtraction < getAutoMemoryExtractionEveryNTurns()
      ) {
        return false;
      }
    }
    this.turnsSinceLastExtraction = 0;
    return true;
  }

  private async doExtraction(
    ctx: PendingContext,
    isTrailingRun = false,
  ): Promise<void> {
    const lastMessage = ctx.messages.at(-1);
    const nativeScopedDirs = getScopedAutoMemoryDirs(this.config);
    const runtimeRoots: SdkAutoMemoryRoot[] = this.sdkGenerationConfig
      ? this.sdkGenerationConfig.roots
      : nativeScopedDirs.map(({ scope, dir }) => ({
          id: scope,
          dir,
          access: 'read-write',
        }));
    const writableRoots = runtimeRoots.filter(
      (root) => root.access === 'read-write',
    );
    const knownMemoryDirs = this.sdkGenerationConfig
      ? runtimeRoots.map(({ dir }) => ({ scope: 'project' as const, dir }))
      : getKnownAutoMemoryDirs(this.config);
    const newMessages = getMessagesSinceCursor(
      ctx.messages,
      this.lastProcessedMessageUuid,
    );
    const newMessageCount = countModelVisibleMessages(newMessages);
    const requestId =
      ctx.parentRequestId ?? getLastAssistantRequestId(newMessages);
    const attemptId = randomUUID();
    const startedAtMs = Date.now();
    let generationCompletion: ForkedAgentCompletion | undefined;

    const isIndexPath = (filePath: string): boolean => {
      if (!this.sdkGenerationConfig) {
        return path.basename(filePath) === MEMORY_INDEX_FILENAME;
      }
      const absoluteFilePath = path.resolve(filePath);
      return runtimeRoots.some(
        (root) =>
          root.indexFile !== undefined &&
          path.resolve(root.dir, root.indexFile) === absoluteFilePath,
      );
    };

    const findMostSpecificRoot = (
      filePath: string,
    ): SdkAutoMemoryRoot | undefined =>
      runtimeRoots
        .filter(({ dir }) => {
          const relative = path.relative(dir, filePath);
          return (
            relative !== '' &&
            !relative.startsWith('..') &&
            !path.isAbsolute(relative)
          );
        })
        .sort((left, right) => right.dir.length - left.dir.length)[0];

    const reportResult = async (params: {
      status: 'success' | 'skipped' | 'failed';
      skipReason?: string;
      errorClass?: string;
      errorMessage?: string;
      memoryPaths?: string[];
      writtenPaths?: string[];
      writeOrigin?: MemoryWriteOrigin;
      writeStats?: AutoMemoryWriteStats;
      generationMethod?: 'auto_fork' | 'auto_independent_incremental';
    }) => {
      const memoryPaths = params.memoryPaths ?? [];
      const writtenPaths = params.writtenPaths ?? memoryPaths;
      const writeStats = params.writeStats;
      const durationMs = Date.now() - startedAtMs;
      const billing = generationCompletion
        ? getForkCompletionBilling(generationCompletion)
        : undefined;
      const writtenFileResults = writtenPaths.flatMap((filePath) => {
        const root = findMostSpecificRoot(filePath);
        return root ? [{ rootId: root.id, path: filePath }] : [];
      });
      const successfulPaths = new Set(
        writtenPaths.map((filePath) => path.resolve(filePath)),
      );
      const failedFilesByPath = new Map<
        string,
        AutoMemoryGenerationResult['failedFiles'][number]
      >();
      for (const failure of writeStats?.failures ?? []) {
        if (!failure.filePath) continue;
        const absolutePath = path.resolve(failure.filePath);
        if (successfulPaths.has(absolutePath)) continue;
        const root = findMostSpecificRoot(absolutePath);
        if (!root) continue;
        failedFilesByPath.set(absolutePath, {
          rootId: root.id,
          path: absolutePath,
          error: failure.errorClass,
        });
      }
      const failedFiles = [...failedFilesByPath.values()];
      const indexUpdated = writtenPaths.some(isIndexPath);
      const contentUpdated = writtenPaths.some(
        (filePath) => !isIndexPath(filePath),
      );
      const origin =
        params.writeOrigin === 'main_session'
          ? ('main_session' as const)
          : ('turn_complete' as const);
      const sdkStatus: AutoMemoryGenerationResult['status'] =
        writtenFileResults.length > 0
          ? failedFiles.length > 0
            ? 'partial'
            : 'saved'
          : params.status === 'failed'
            ? 'failed'
            : params.skipReason === 'no_memory_written'
              ? 'no_change'
              : 'skipped';
      this.callbacks.onGenerationResult?.({
        status: sdkStatus,
        attemptId,
        reason:
          sdkStatus === 'saved'
            ? undefined
            : sdkStatus === 'partial'
              ? 'Some memory files could not be written'
              : (params.skipReason ?? params.errorMessage ?? params.errorClass),
        origin,
        sourceRequestIds: requestId ? [requestId] : undefined,
        modelRequestIds: generationCompletion?.modelRequestIds,
        writtenFiles: writtenFileResults,
        failedFiles,
        indexUpdated,
        contentUpdated,
        durationMs,
        usage: generationCompletion?.totalUsage,
        credits: billing?.credits,
      });
    };

    if (this.config.isPlanMode?.()) {
      runLogger.debug('[AutoMemory] skipping extraction; plan mode is active');
      if (lastMessage?.uuid) {
        this.lastProcessedMessageUuid = lastMessage.uuid;
      }
      await reportResult({
        status: 'skipped',
        skipReason: 'plan_mode_active',
      });
      return;
    }

    let directWriteStats: AutoMemoryWriteStats | undefined;
    let directActiveScopeWriteStats: AutoMemoryWriteStats | undefined;
    let extractionError: string | undefined;
    let extractionStarted = false;

    try {
      // Active memory roots may contain PROJECT, USER, or both.
      await Promise.all(
        runtimeRoots.map(({ dir }) => ensureAutoMemoryDir(dir)),
      );

      directWriteStats =
        newMessages.length > 0
          ? collectAutoMemoryWriteStats(
              newMessages,
              knownMemoryDirs.map(({ dir }) => dir),
              this.config.getWorkingDir(),
            )
          : undefined;
      directActiveScopeWriteStats =
        newMessages.length > 0
          ? collectAutoMemoryWriteStats(
              newMessages,
              writableRoots.map(({ dir }) => dir),
              this.config.getWorkingDir(),
            )
          : undefined;

      if (
        directActiveScopeWriteStats &&
        directActiveScopeWriteStats.successCount > 0
      ) {
        const directReportStats =
          directWriteStats ?? directActiveScopeWriteStats;
        runLogger.debug(
          '[AutoMemory] skipping extraction; current turn already wrote memory files',
        );
        if (lastMessage?.uuid) {
          this.lastProcessedMessageUuid = lastMessage.uuid;
        }
        await reportResult({
          status: 'skipped',
          skipReason: 'main_session_direct_memory_write',
          memoryPaths: directReportStats.successfulPaths.filter(
            (filePath) => !isIndexPath(filePath),
          ),
          writtenPaths: directReportStats.successfulPaths,
          writeOrigin: 'main_session',
          writeStats: directReportStats,
        });
        return;
      }

      // Match the native extraction cadence: count only eligible turns. Keep
      // the cursor unchanged while throttled so the eventual run sees all
      // model-visible messages accumulated across the N turns. A context that
      // arrived while a fork was already running is committed work and runs
      // immediately rather than being throttled a second time.
      if (!this.shouldRunForTurnCompleteInterval(ctx, isTrailingRun)) {
        await reportResult({
          status: 'skipped',
          skipReason: 'turn_interval_gate',
        });
        return;
      }

      const sdkControlled =
        isSDKMode() ||
        this.sdkGenerationConfig !== undefined ||
        this.config.isSdkMemoryRequestActive?.() === true;
      if (!sdkControlled) {
        const selection = this.generationStrategySession.resolve(false);
        if (selection.kind === 'independent_model_incremental') {
          this.getOrCreateIndependentIncrementalAgent(selection).schedule(
            ctx,
            async (result) => {
              generationCompletion = {
                model: result.model,
                requestId: result.modelRequestIds.at(-1),
                modelRequestIds: result.modelRequestIds,
                modelRequests: result.modelRequests,
                modelRequestResults: result.modelRequestResults,
                totalUsage: result.totalUsage,
                durationMs: result.durationMs,
                success: result.status === 'completed',
              };
              const memoryPaths = result.writtenPaths.filter(
                (filePath) => path.basename(filePath) !== MEMORY_INDEX_FILENAME,
              );
              const status =
                result.status === 'completed'
                  ? memoryPaths.length > 0
                    ? 'success'
                    : result.writeStats.failedCount > 0
                      ? 'failed'
                      : 'skipped'
                  : 'failed';
              // Route the independent incremental agent's terminal outcome
              // through the shared auto-memory generation result callback.
              await reportResult({
                status,
                skipReason:
                  status === 'skipped' ? 'no_memory_written' : undefined,
                errorClass:
                  status === 'failed'
                    ? result.status === 'stopped'
                      ? 'aborted'
                      : 'independent_memory_agent_failed'
                    : undefined,
                errorMessage: result.error,
                memoryPaths,
                writtenPaths: result.writtenPaths,
                writeOrigin:
                  result.writeStats.attemptCount > 0
                    ? 'auto_independent_agent'
                    : 'none',
                writeStats: result.writeStats,
                generationMethod: 'auto_independent_incremental',
              });
              if (result.status === 'completed' && memoryPaths.length > 0) {
                this.callbacks.onMemoriesSaved?.(memoryPaths);
                this.callbacks.onMemoryRefresh?.();
              }
            },
          );
          return;
        }
      }

      let directive: string;
      if (this.sdkGenerationConfig) {
        directive = [
          'You are now acting as the memory extraction subagent.',
          '',
          this.sdkGenerationConfig.prompt,
          '',
          'SDK-controlled memory roots:',
          ...runtimeRoots.map(
            (root) =>
              `- ${root.id}: ${root.dir} (${root.access}${
                root.indexFile ? `; index: ${root.indexFile}` : ''
              })`,
          ),
          '',
          'Use only these roots. Do not access a root parent or sibling path.',
        ].join('\n');
      } else {
        // Native mode keeps the existing MEMORY.md index and manifest prompt.
        const roots: MemoryExtractionRoot[] = await Promise.all(
          nativeScopedDirs.map(async ({ scope, dir }) => {
            const [index, files] = await Promise.all([
              loadMemoryIndex(getMemoryIndexPath(dir)),
              listMemoryFileNames(dir),
            ]);
            return { scope, dir, index, files };
          }),
        );
        directive = buildMemoryExtractionDirective(roots, newMessageCount);
      }

      const parentSnapshot = ctx.cacheSafeQuerySnapshot;
      const extractionModel = parentSnapshot?.model ?? this.config.getModel();
      // Prefer the completed parent request's exact API-ready prefix. The
      // legacy reconstruction remains for session owners that have not wired
      // cache-safe snapshots yet.
      const forkContextMessages =
        parentSnapshot?.forkContextMessages ??
        buildForkContextMessages(
          ctx.messages,
          this.config.getMemoryContextManager?.()?.getUserContext(),
          buildModelProjectionOptions(this.config, extractionModel),
        );

      const forkFailureByToolUseId = new Map<string, AutoMemoryWriteFailure>();
      const {
        toolRegistry: childSchemaRegistry,
        agentContext: memoryAgentContext,
      } = buildMemoryForkBridge(this.config, runtimeRoots, (call) => {
        const toolName = call.request.name;
        if (toolName !== WRITE_FILE_TOOL_NAME && toolName !== EDIT_TOOL_NAME) {
          return;
        }
        if (
          call.status === CoreToolCallStatus.Success &&
          call.response.isError !== true
        ) {
          return;
        }
        forkFailureByToolUseId.set(call.request.callId, {
          toolCallId: call.request.callId,
          toolName,
          errorClass:
            call.response.errorType ??
            (call.status === CoreToolCallStatus.Cancelled
              ? 'cancelled'
              : 'tool_result_error'),
        });
      });
      // Advertise parent's exact tool schemas so the fork's prefix (system +
      // tools + history) is byte-identical to the parent's — enabling prompt
      // cache hits on the replayed history. Execution is still restricted to
      // MEMORY_FORK_ALLOWED_TOOLS via the child bridge's permission context.
      const toolRegistry =
        wrapWithParentToolSchemas(
          parentSnapshot?.toolSchemas ?? this.config.getParentToolSchemas?.(),
          this.config,
          childSchemaRegistry,
        ) ?? childSchemaRegistry;

      this.callbacks.onExtractionStarted?.();
      extractionStarted = true;

      const rootSessionId = this.config.getSessionId();
      let forkResult: Awaited<ReturnType<typeof runForkedAgent>>;
      try {
        forkResult = await runForkedAgent({
          config: this.config,
          parentSelection:
            parentSnapshot?.model === extractionModel
              ? parentSnapshot.modelResolution
              : undefined,
          prompt: directive,
          sessionId: rootSessionId,
          promptId: 'memory-fork',
          systemPrompt: parentSnapshot
            ? parentSnapshot.systemPrompt
            : ctx.systemPrompt,
          forkContextMessages,
          forkLabel: 'memory-fork',
          maxTurns: 5,
          ...(parentSnapshot
            ? {
                maxOutputTokens: parentSnapshot.maxOutputTokens,
                thinkingBudget: parentSnapshot.thinkingBudget,
                reasoningEffort: parentSnapshot.reasoningEffort,
                generation: parentSnapshot.generation,
                contextWindow: parentSnapshot.contextWindow,
              }
            : {}),
          toolRegistry,
          toolExecutor: this.config.getToolExecutor(),
          agentContext: memoryAgentContext,
          parentRequestSetId: ctx.parentRequestSetId,
          parentBusinessInfo: ctx.parentBusinessInfo,
          customContext: ctx.customContext,
          skipCacheWrite: true,
          workdirs: this.config.getWorkspaceContext().getDirectories(),
          sessionScopeId: rootSessionId,
          onCompleted: (completion) => {
            generationCompletion = completion;
          },
        });
      } finally {
        toolRegistry.dispose();
      }
      if (lastMessage?.uuid) {
        this.lastProcessedMessageUuid = lastMessage.uuid;
      }

      // Count only what THIS fork successfully wrote, derived from its own result
      // messages —
      // never from a directory file-count snapshot. A before/after directory diff
      // races with concurrent foreground memory writes: while this fork is in
      // flight, the next user turn (coalesced into pendingContext) can save memory
      // files itself, inflating the "after" count and making the banner claim the
      // background extraction saved memories it never wrote. Reading the fork's own
      // successful Write/Edit tool results isolates its contribution. Native and
      // explicitly declared custom index touches are excluded from content files.
      const forkWriteStats = collectAutoMemoryWriteStats(
        forkResult.messages,
        writableRoots.map(({ dir }) => dir),
        this.config.getWorkingDir(),
        forkFailureByToolUseId,
      );
      const writtenPaths = forkWriteStats.successfulPaths;
      const memoryPaths = writtenPaths.filter(
        (filePath) => !isIndexPath(filePath),
      );
      const newMemories = memoryPaths.length;
      const savedChanges = this.sdkGenerationConfig
        ? writtenPaths.length
        : newMemories;
      const writeOrigin = memoryWriteOrigin({
        mainSessionAttempted: (directWriteStats?.attemptCount ?? 0) > 0,
        autoForkAttempted: forkWriteStats.attemptCount > 0,
      });
      const writeStats = mergeAutoMemoryWriteStats(
        directWriteStats,
        forkWriteStats,
      );
      const status =
        savedChanges > 0
          ? 'success'
          : writeStats.failedCount > 0
            ? 'failed'
            : 'skipped';
      await reportResult({
        status,
        skipReason: status === 'skipped' ? 'no_memory_written' : undefined,
        errorClass: status === 'failed' ? 'memory_write_failed' : undefined,
        memoryPaths,
        writtenPaths,
        writeOrigin,
        writeStats,
      });
      if (savedChanges > 0) {
        runLogger.log(
          `[AutoMemory] Saved ${savedChanges} memory change${savedChanges === 1 ? '' : 's'}: ${writtenPaths
            .map((filePath) => path.basename(filePath))
            .join(', ')}`,
        );
        // Hand only content-file paths to the display layer so its transient
        // success count excludes native or explicitly declared index writes.
        if (memoryPaths.length > 0) {
          this.callbacks.onMemoriesSaved?.(memoryPaths);
        }
        this.callbacks.onMemoryRefresh?.();
      }
    } catch (err) {
      extractionError = err instanceof Error ? err.message : String(err);
      await reportResult({
        status: 'failed',
        errorClass: getErrorClass(err),
        errorMessage: extractionError,
        writeOrigin:
          (directWriteStats?.attemptCount ?? 0) > 0 ? 'main_session' : 'none',
        writeStats: directWriteStats,
      });
      throw err;
    } finally {
      if (extractionStarted) {
        this.callbacks.onExtractionFinished?.(
          extractionError
            ? {
                status: 'failed',
                error: extractionError,
                parentRequestSetId: ctx.parentRequestSetId,
              }
            : {
                status: 'completed',
                parentRequestSetId: ctx.parentRequestSetId,
              },
        );
      }
    }
  }
}
