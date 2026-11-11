/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import React, { type MutableRefObject } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeI18nService,
  resetI18nService,
} from '../../../../core/src/i18n/index.js';
import { StreamingToolExecutor } from '../../../../core/src/tool-executor/index.js';
import { watch } from 'chokidar';
import type { CompressOptions } from '../../../../core/src/compression-v2/pipeline.js';
import type { ModelSelectContext } from '../../../../core/src/provider/model/modelSelectContext.js';
import { testModelResolution } from '../../../../core/src/test-utils/model-resolution.js';
import { ModelNotFoundError } from '../../../../core/src/utils/httpErrors.js';
import {
  fixedSelection,
  withSessionSelection,
} from '../../../../core/src/test-utils/request-model.js';
import { createAttachmentMessage } from '../../../../core/src/attachments/factory.js';
import { EnvironmentAttachment } from '../../../../core/src/attachments/models/environment-attachment.js';
import { SessionContextAttachment } from '../../../../core/src/attachments/models/session-context-attachment.js';
import { createFileChangedWatcher } from '../../../../core/src/hooks/fileChangedWatcher.js';
import type { HookRegistry } from '../../../../core/src/hooks/hookRegistry.js';
import type { HookEventHandler } from '../../../../core/src/hooks/hookEventHandler.js';

import { cloneUsage } from '../../../../core/src/protocol/provider/empty-usage.js';
import * as Shell from '../../../../core/src/utils/Shell.js';
import { worktreeSessionService } from '../../../../core/src/services/worktreeSessionService.js';
import { FileHistoryManager as RealFileHistoryManager } from '../../../../core/src/file-history/file-history.js';
import { runWithWorkspaceTransition } from '../../../../core/src/utils/workspaceTransition.js';
import { TranscriptStore } from '../../../../core/src/services/transcript/store.js';
import { TranscriptRepository } from '../../../../core/src/services/transcript/repository.js';
import { nodeTranscriptFileSystem } from '../../../../core/src/services/transcript/append-channel.js';
import {
  applyMcpLazyLoad,
  applyPostCompact,
  AuthType,
  type AttachmentToolUseContext,
  type Config,
  createAttachmentContext,
  createTurnPromptResolver,
  buildStartupMemoryPrefix,
  countRequestTokens,
  uiTelemetryService,
  type FileHistoryManager,
  type Message,
  type ModelConfig,
  type PromptBuildResult,
  type TurnPromptResolver,
  type WorktreeSettings,
  executeUserInput,
  ensureConfigReadyForRequest,
  getAttachmentMessages,
  getSkillListingConfig,
  getModelVisibleSkillsForTools,
  generateSessionTitleForCurrentSession,
  HookEventName,
  isVisionSupportedModel,
  isChainParticipant,
  isCommandStyleUserPromptText,
  isHumanTaskInputMessage,
  isTitleEligibleAssistantMessage,
  parseAndFormatApiErrorMessage,
  formatApiErrorDisplayMessage,
  materializePastedContents,
  migrateLegacyWorktreeTranscript,
  processPastedImages,
  query,
  seedStartupStaticMemoryFileReadState,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { MessageType, StreamingState } from '../types.js';
import { createSessionUiBinding } from '../session/prepareSessionUi.js';
import {
  NOOP_RUNTIME_PROJECTION,
  type LocalTuiSessionOrchestratorResult,
  type RuntimeProjectionController,
} from './localSession.shared.js';
import {
  buildBashCommandProcessResult,
  createRuntimeMessageUuidDeduplicator,
  createTurnPromptResolverAfterRegistryReady,
  isChildScopedQueryEvent,
  useLocalTuiSessionOrchestrator,
} from './useLocalTuiSessionOrchestrator.js';

const fixtureFileWatcher = createFileChangedWatcher();

beforeEach(() => initializeI18nService());
afterEach(() => resetI18nService());

const mockApproveExternalImportsForProject = vi.hoisted(() =>
  vi.fn(() => true),
);

const coreMocks = vi.hoisted(() => {
  vi.resetModules();
  return {
    cwd: process.cwd(),
    compressionPipelineInstances: [] as Array<{
      compress: ReturnType<typeof vi.fn>;
      options: { target: string; modelProviderManager: unknown };
    }>,
    fileHistoryManagerInstances: [] as Array<{
      args: {
        cwd: string;
        sessionId: string;
        enabled: boolean;
        acceptLegacySnapshots?: boolean;
      };
      makeSnapshot: ReturnType<typeof vi.fn>;
      reset: ReturnType<typeof vi.fn>;
      rehydrateFromResume: ReturnType<typeof vi.fn>;
      setRecorder: ReturnType<typeof vi.fn>;
      setSessionId: ReturnType<typeof vi.fn>;
    }>,
    restoreInvokedSkillsFromTranscript: vi.fn(),
    applyResumeWorktreeState: vi.fn(),
    rehydrateFileHistory: vi.fn(async (_options?: unknown) => undefined),
    originalCwd: process.cwd(),
    bindSessionUsagePersistence: vi.fn(
      async (): Promise<() => Promise<void>> => async () => undefined,
    ),
    flushSessionUsage: vi.fn(async () => undefined),
    executeConversationRewind: vi.fn(),
    sessionStateStoreInstances: [] as Array<{
      args: { projectRoot: string; sessionId: string };
      setWorkspaceDirectories: ReturnType<typeof vi.fn>;
    }>,
    promptAssemblerContexts: [] as unknown[],
    setWorkspaceDirectoriesImpl: vi.fn(
      async (_directories: readonly string[]): Promise<void> => undefined,
    ),
    transcriptWriterInstances: [] as Array<{
      args: { cwd: string; filePath: string; sessionId: string };
      adoptMainParentUuid: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      getSessionId: () => string;
      getSessionFilePath: () => string;
      recordActiveLeaf: ReturnType<typeof vi.fn>;
      recordFileHistorySnapshot: ReturnType<typeof vi.fn>;
      recordMessages?: ReturnType<typeof vi.fn>;
      recordRuntimeConfig?: ReturnType<typeof vi.fn>;
      recordWorktreeState: ReturnType<typeof vi.fn>;
      relocate?: ReturnType<typeof vi.fn>;
    }>,
    getPromptSuggestionFeatureConfig: vi.fn(
      (): import('@qwen-code/core').PromptSuggestionFeatureConfig => ({
        enabled: true,
        mode: 'legacy',
        forkEnabled: false,
      }),
    ),
    subscribePromptSuggestionFeatureGate: vi.fn<
      typeof import('@qwen-code/core').subscribePromptSuggestionFeatureGate
    >(() => undefined),
    tryGeneratePromptSuggestion: vi.fn(),
    capturePromptSuggestionForkSource: vi.fn(),
  };
});

const rootToolRegistryMocks = vi.hoisted(() => ({
  registerTool: vi.fn(),
  unregisterTool: vi.fn(),
  mainRegistryProviders: [] as unknown[],
}));

const builtinPluginMocks = vi.hoisted(() => ({
  promptSuggestionContributions: vi.fn(
    (): Array<{
      id: string;
      prompt: string;
    }> => [],
  ),
}));

vi.mock('../../app-plugins/registry.js', () => ({
  getAppPlugins: () => ({
    getAppPluginPromptSuggestionContributions:
      builtinPluginMocks.promptSuggestionContributions,
  }),
}));

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock('@qwen-code/core', async () => ({
  parseSdkInputBlock: (
    await import('../../../../core/src/engine/headless-projection.js')
  ).parseSdkInputBlock,
  parseAtMentionedPaths: (
    await import(
      '../../../../core/src/attachments/generators/file-generators.js'
    )
  ).parseAtMentionedPaths,
  ENV_RUNNING_ENV: (await import('../../../../core/src/config/brand.js'))
    .ENV_RUNNING_ENV,
  PermissionModeUnavailableError: (
    await import('../../../../core/src/permissions/manager/policy.js')
  ).PermissionModeUnavailableError,
  resolveModelSelectionOverride: (
    await import('../../../../core/src/provider/session-model.js')
  ).resolveModelSelectionOverride,
  modelConfigFromGeneration: (
    await import('../../../../core/src/config/generation-config.js')
  ).modelConfigFromGeneration,
  generationFromModelConfig: (
    await import('../../../../core/src/config/generation-config.js')
  ).generationFromModelConfig,
  isContextWindowSelectionEnabled: () => true,
  isVisionSupportedModel: vi.fn(() => true),
  IMAGE_EXTENSIONS: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']),
  restoreAttachment: (
    await import('../../../../core/src/attachments/transcript-conversion.js')
  ).restoreAttachment,
  snapshotAttachmentDeltaState: (
    await import('../../../../core/src/attachments/transcript-state.js')
  ).snapshotAttachmentDeltaState,
  createQueryBusinessInfo: vi.fn(
    async (_sessionId, name, id, _source, modelKey) => ({
      id,
      model_key: modelKey,
      name,
      version: '1.0.0',
      product: 'cli',
      type: 'agent',
    }),
  ),
  businessInfoContext: { run: vi.fn((_business, callback) => callback()) },
  isAccountSuspendedError: vi.fn(() => false),
  getErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  AuthType: {
    QODER_BROWSER: 'qoder-browser',
    QODER_PAT: 'qoder-pat',
  },
  applyMcpLazyLoad: vi.fn(async () => undefined),
  BRAND_CLI_NAME: 'Qwen Code',
  BRAND_CLI_BIN: 'qwen',
  BRAND_ENV_PREFIX: 'QWEN_',
  BRAND_FIXED_ENV_PREFIX: 'QWEN_',
  BRAND_EVENT_PREFIX: 'qwen_',
  BRAND_IGNORE_FILE: '.qwenignore',
  BRAND_NAME: 'Qwen Code',
  buildSlashCommandMetadata: (commandName: string, args?: string) =>
    [
      `<command-message>${commandName}</command-message>`,
      `<command-name>/${commandName}</command-name>`,
      ...(args ? [`<command-args>${args}</command-args>`] : []),
    ].join('\n'),
  CompressionPipeline: class {
    compress = vi.fn();

    constructor(
      readonly options: { target: string; modelProviderManager: unknown },
    ) {
      coreMocks.compressionPipelineInstances.push(this);
    }
  },
  CompressionStatus: {
    COMPRESSED: 'compressed',
    DISABLED: 'disabled',
    FAILED: 'failed',
    NOOP: 'noop',
  },
  ConversationRewindError: class ConversationRewindError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ConversationRewindError';
    }
  },
  CoreToolCallStatus: {
    Canceled: 'canceled',
    Error: 'error',
    Success: 'success',
  },
  CoreEvent: {
    MemoryChanged: 'MemoryChanged',
    PermissionModeChanged: 'PermissionModeChanged',
  },
  ExitCodes: {
    FATAL_CANCELLATION_ERROR: 130,
    SUCCESS: 0,
  },
  ENV_PAT: 'GEMINI_API_KEY',
  ENV_BASH_PATH: 'QWEN_BASH_PATH',
  ENV_SHELL_PREFIX: 'QWEN_SHELL_PREFIX',
  ENV_GIT_BASH_PATH: (await import('../../../../core/src/config/brand.js'))
    .ENV_GIT_BASH_PATH,
  ENV_SHELL_PREFIX_COMPAT: 'CLAUDE_CODE_SHELL_PREFIX',
  HookEventName: {
    SessionStart: 'SessionStart',
    UserPromptSubmit: 'UserPromptSubmit',
  },
  DEFAULT_LIFECYCLE_OBSERVER_TIMEOUT_MS: 1000,
  DEFAULT_MAX_TURNS: 100,
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS: (
    await import('../../../../core/src/config/modelRequestConfig.js')
  ).DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_CONTEXT_FILENAME: 'AGENTS.md',
  DEFAULT_MODEL_CONFIGS: { aliases: {} },
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD: 40_000,
  DefaultHookCoordinator: class {
    dispose = vi.fn();
  },
  FileHistoryManager: class extends (
    await import('../../../../core/src/file-history/file-history.js')
  ).FileHistoryManager {
    args: {
      cwd: string;
      sessionId: string;
      enabled: boolean;
      acceptLegacySnapshots?: boolean;
    };
    override makeSnapshot = vi.fn(async () => undefined);
    override reset = vi.fn();
    override rehydrateFromResume = vi.fn((options: unknown) =>
      coreMocks.rehydrateFileHistory(options),
    );
    override setRecorder = vi.fn();
    override setSessionId = vi.fn();

    constructor(args: {
      cwd: string;
      sessionId: string;
      enabled: boolean;
      acceptLegacySnapshots?: boolean;
    }) {
      super(args);
      this.args = args;
      coreMocks.fileHistoryManagerInstances.push(this);
    }
  },
  NoopHookCoordinator: class {
    dispose = vi.fn();
  },
  ROOT_TOOL_CALL_SCOPE_ID: 'root-scheduler',
  REMOVED_MODEL_GENERATION_FIELDS: [],
  REMOVED_PROVIDER_MODEL_FIELDS: [],
  SHELL_TOOL_NAME: 'Bash',
  SessionStateStore: class {
    args: { projectRoot: string; sessionId: string };
    setWorkspaceDirectories = vi.fn((directories: readonly string[]) =>
      coreMocks.setWorkspaceDirectoriesImpl(directories),
    );

    constructor(args: { projectRoot: string; sessionId: string }) {
      this.args = args;
      coreMocks.sessionStateStoreInstances.push(this);
    }

    getSessionStatePath() {
      return nodePath.join(
        this.args.projectRoot,
        `${this.args.sessionId}.state.json`,
      );
    }
  },
  Storage: class {
    static getGlobalConfigDir() {
      return nodePath.join(tmpdir(), '.qwen');
    }

    static getGlobalSettingsPath() {
      return nodePath.join(this.getGlobalConfigDir(), 'settings.json');
    }
  },
  SystemPromptAssembler: class {
    clearCache = vi.fn();

    constructor(options: { sessionId: string }) {
      coreMocks.promptAssemblerContexts.push(options.sessionId);
    }
  },
  ToolConfirmationOutcome: {
    Cancel: 'cancel',
    ProceedAlways: 'proceed_always',
    ProceedOnce: 'proceed_once',
  },
  TASK_UPDATE_TOOL_NAME: 'task_update',
  WRITE_TODOS_TOOL_NAME: 'write_todos',
  applyPostCompact: vi.fn(),
  buildSystemPromptForTurn: vi.fn(async () => ''),
  buildSystemPromptResultForTurn: vi.fn(async (_assembler, options) =>
    options.resolvedSource?.source === 'default'
      ? { text: '', source: 'default', bundle: 'full' }
      : { text: '', source: options.resolvedSource?.source ?? 'default' },
  ),
  checkExhaustive: vi.fn((value) => {
    throw new Error(`Unexpected value: ${String(value)}`);
  }),
  clearSystemContext: vi.fn(),
  clearSessionPromptCaches: vi.fn(),
  cloneUsage: vi.fn((usage) => usage),
  coreEvents: {
    emitFeedback: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
  },
  countAiTitleCadenceHumanPromptMessages: vi.fn(() => 0),
  createCache: vi.fn(() => {
    const values = new Map<unknown, unknown>();
    return {
      clear: () => values.clear(),
      getOrCreate: (key: unknown, factory: () => unknown) => {
        if (!values.has(key)) {
          values.set(key, factory());
        }
        return values.get(key);
      },
    };
  }),
  createAssistantMessage: vi.fn((text = '') => ({
    message: { content: [{ text, type: 'text' }] },
    type: 'assistant',
    uuid: 'assistant-message',
  })),
  createAttachmentContext: vi.fn((cwd: string, agentId?: string) => ({
    agentId,
    announcedAgentTypes: new Set(),
    announcedLazyMcpTools: new Set(),
    announcedMcpInstructionServers: new Set(),
    cwd,
    isFirstTurnSeedDone: false,
    loadedNestedMemoryPaths: new Set(),
    pendingHookAttachments: [],
    pendingHookOutputs: [],
    readFileState: new Map(),
    seenSessionStartHookOutputs: new Set(),
    sentSkillNames: new Map(),
  })),
  restoreAttachmentTranscriptState: vi.fn(
    (
      ctx: AttachmentToolUseContext,
      messages: Array<{
        type?: string;
        attachment?: Record<string, unknown>;
      }>,
    ) => {
      ctx.sentSkillNames.clear();
      ctx.seenSessionStartHookOutputs.clear();
      const names = new Set<string>();
      for (const message of messages) {
        const attachment = message.attachment;
        if (message.type !== 'attachment' || !attachment) continue;
        if (attachment['type'] === 'skill_listing') {
          for (const name of (attachment['names'] as string[]) ?? []) {
            names.add(name);
          }
        }
        if (
          attachment['type'] === 'hook_output' &&
          attachment['hookEventName'] === 'SessionStart'
        ) {
          ctx.seenSessionStartHookOutputs.add(
            JSON.stringify(attachment['output']),
          );
        }
      }
      if (names.size > 0) {
        ctx.sentSkillNames.set(ctx.agentId ?? 'main', names);
      }
    },
  ),
  restoreInvokedSkillsFromTranscript:
    coreMocks.restoreInvokedSkillsFromTranscript,
  // Mirrors core/attachments/generators/hook-generators.ts: SessionStart
  // payloads already present in restored history are dropped, everything
  // else is queued for the next drain.
  enqueueHookOutput: vi.fn(
    (
      ctx: AttachmentToolUseContext,
      payload: { hookEventName?: string; output: string },
    ) => {
      if (payload.hookEventName === 'SessionStart') {
        const fingerprint = JSON.stringify(payload.output);
        if (ctx.seenSessionStartHookOutputs.has(fingerprint)) return;
        ctx.seenSessionStartHookOutputs.add(fingerprint);
      }
      ctx.pendingHookOutputs.push(
        payload as AttachmentToolUseContext['pendingHookOutputs'][number],
      );
    },
  ),
  buildStartupMemoryPrefix: vi.fn(() => []),
  createStartupMemoryContext: vi.fn(() => Object.freeze({})),
  createTurnPromptResolver: vi.fn(
    async () => async () =>
      ({ blocks: [], source: 'default', bundle: 'full' }) as const,
  ),
  // Mirrors core/compact-request-resolver.ts: memoized compact resolve,
  // direct-connection lock-step, degrade-to-parent on failure, rethrow cancellation.
  createCompactRequestResolver: (
    await vi.importActual<
      typeof import('../../../../core/src/core/compact-request-resolver.js')
    >('../../../../core/src/core/compact-request-resolver.js')
  ).createCompactRequestResolver,
  createSyntheticUserCaveatMessage: vi.fn((text = '') => ({
    message: { content: [{ text, type: 'text' }] },
    type: 'user',
    uuid: 'synthetic-user-message',
  })),
  createSystemMessage: vi.fn((text = '') => ({
    content: text,
    role: 'system',
    type: 'system',
  })),
  createUserMessage: vi.fn(
    (text = '', options: Record<string, unknown> = {}) => ({
      message: { content: [{ text, type: 'text' }] },
      type: 'user',
      ...options,
      uuid: options['uuid'] ?? 'user-message',
    }),
  ),
  diagnosticLogger: {
    debugMessage: vi.fn(),
  },
  DefaultI18nCatalog: (
    await import('../../../../core/src/i18n/default-i18n-catalog.js')
  ).DefaultI18nCatalog,
  ensureQwenRuntimeReady: vi.fn(async () => ({ authenticated: true })),
  ensureConfigReadyForRequest: vi.fn(async () => ({
    status: 'ready',
    source: 'local',
    revision: 'test',
  })),
  loadLatestSessionUsage: vi.fn(async () => null),
  countRequestTokens: vi.fn(() => ({ tokens: 0, source: 'estimate' })),
  buildModelProjectionOptions: vi.fn((_config, targetModel) => ({
    targetModel,
  })),
  executeConversationRewind: coreMocks.executeConversationRewind,
  executeUserInput: vi.fn(),
  escapeXml: vi.fn((value: string) => value),
  filterOrphanedImages: vi.fn((messages) => messages),
  generateSessionTitleForCurrentSession: vi.fn(async () => undefined),
  getAttachmentMessages: vi.fn(() => []),
  getSkillListingConfig: vi.fn(() => ({})),
  getModelVisibleSkillsForTools: vi.fn(() => []),
  getContentBlocks: vi.fn(() => []),
  getOriginalCwd: vi.fn(() => coreMocks.originalCwd),
  getSessionTranscriptPath: vi.fn((projectRoot: string, sessionId: string) =>
    nodePath.join(projectRoot, `${sessionId}.jsonl`),
  ),
  getSystemContext: vi.fn(() => undefined),
  isSameOrChildPath: (child: string, parent: string) => {
    const normalize = (p: string) => {
      let resolved: string;
      try {
        resolved = realpathSync(p);
      } catch {
        resolved = p;
      }
      return nodePath.resolve(resolved).normalize('NFC');
    };
    const childNorm = normalize(child);
    const parentNorm = normalize(parent);
    const rel = nodePath.relative(parentNorm, childNorm);
    return (
      rel === '' ||
      (!!rel && !rel.startsWith('..') && !nodePath.isAbsolute(rel))
    );
  },
  normalizePathForCompare: (p: string) => {
    let resolved: string;
    try {
      resolved = realpathSync(p);
    } catch {
      resolved = p;
    }
    return nodePath.resolve(resolved).normalize('NFC');
  },
  normalizePath: (p: string) => nodePath.normalize(p),
  ownsWorktreeLifecycle: (settings: WorktreeSettings) =>
    settings.lifecycle === 'owner',
  homedir: vi.fn(() => tmpdir()),
  isAbortError: vi.fn(
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  ),
  isCancellationError: vi.fn(
    (error: unknown, signal?: AbortSignal) =>
      signal?.aborted === true ||
      (error instanceof Error &&
        (error.name === 'AbortError' ||
          error.message.toLowerCase().includes('operation cancelled') ||
          error.message.toLowerCase().includes('operation canceled') ||
          error.message.toLowerCase().includes('cancelled by user') ||
          error.message.toLowerCase().includes('canceled by user'))),
  ),
  isChainParticipant: vi.fn(() => false),
  isCommandStyleUserPromptText: vi.fn(() => false),
  isSDKMode: vi.fn(() => false),
  // Only the bits this suite varies; the real rule is unit-tested in core.
  isHumanTaskInputMessage: vi.fn(
    (message?: { isMeta?: boolean; humanInput?: { mode?: string } }) =>
      message?.humanInput?.mode === 'prompt' && message.isMeta !== true,
  ),
  isTaskTriggeringPrompt: vi.fn(() => false),
  isTitleEligibleAssistantMessage: vi.fn(() => false),
  makeFakeConfig: vi.fn(() => ({})),
  normalizeMessagesForAPI: vi.fn((messages) => messages),
  isContextAttachmentMessage: (
    await vi.importActual<typeof import('@qwen-code/core')>(
      '@qwen-code/core',
    )
  ).isContextAttachmentMessage,
  parseAndFormatApiError: vi.fn((message: unknown) => String(message)),
  parseAndFormatApiErrorMessage: vi.fn((message: unknown) => String(message)),
  findModelInferenceError: (
    await import('../../../../core/src/provider/modelInferenceError.js')
  ).findModelInferenceError,
  getResultErrorCode: (
    await import('../../../../core/src/utils/resultErrorCode.js')
  ).getResultErrorCode,
  resolveErrorPresentation: (
    await import('../../../../core/src/utils/errorPresentation.js')
  ).resolveErrorPresentation,
  QODER_PROVIDER_ID: 'qoder',
  formatApiErrorDisplayMessage: vi.fn(
    (await import('../../../../core/src/utils/errorParsing.js'))
      .formatApiErrorDisplayMessage,
  ),
  parseReasoningEffortLevel: vi.fn((value) => value),
  parseImagePlaceholderIds: vi.fn(() => []),
  materializePastedContents: vi.fn(async (contents) => contents),
  partToString: vi.fn((part) =>
    typeof part === 'string'
      ? part
      : typeof part?.text === 'string'
        ? part.text
        : '',
  ),
  pickQueryOverrides: vi.fn(
    (
      await vi.importActual<
        typeof import('../../../../core/src/commands/types.js')
      >('../../../../core/src/commands/types.js')
    ).pickQueryOverrides,
  ),
  processPastedImages: vi.fn(async () => []),
  query: vi.fn(),
  createQueryEventBus: vi.fn(() => ({ dispose: vi.fn() })),
  getPromptSuggestionFeatureConfig: coreMocks.getPromptSuggestionFeatureConfig,
  isPromptSuggestionPolicyCurrent: (
    await import(
      '../../../../core/src/config-service/features/promptSuggestion.js'
    )
  ).isPromptSuggestionPolicyCurrent,
  subscribePromptSuggestionFeatureGate:
    coreMocks.subscribePromptSuggestionFeatureGate,
  tryGeneratePromptSuggestion: coreMocks.tryGeneratePromptSuggestion,
  capturePromptSuggestionForkSource:
    coreMocks.capturePromptSuggestionForkSource,
  canGeneratePromptSuggestionFork: (
    await import('../../../../core/src/services/promptSuggestionFork.js')
  ).canGeneratePromptSuggestionFork,
  bindSessionUsagePersistence: coreMocks.bindSessionUsagePersistence,
  INTERACTIVE_USAGE_REQUEST_SETTLE_TIMEOUT_MS: 1_500,
  flushSessionUsage: coreMocks.flushSessionUsage,
  recordSessionUsage: vi.fn(),
  recordSessionUsageInMemory: vi.fn(),
  recordInitialWorktreeTranscriptState: vi.fn(async (config, writer) => {
    const settings = config.getWorktreeSettings?.();
    await writer.recordWorktreeState(
      settings
        ? {
            originalCwd: settings.originalCwd,
            preEnterOriginalCwd: settings.originalCwd,
            worktreePath: settings.path,
            worktreeCwd: settings.worktreeCwd,
            worktreeName: settings.name,
            sessionId: config.getSessionId(),
            lifecycle: settings.lifecycle,
          }
        : null,
    );
  }),
  migrateLegacyWorktreeTranscript: vi.fn(async (request) => {
    await request.relocate(request.originalCwd);
  }),
  resolveEffectiveAuthType: vi.fn((authType) => authType),
  resolveEffectivePromptSource: vi.fn((options) => {
    if (options.overrideSystemPrompt !== undefined) {
      return { source: 'override', fixedBody: options.overrideSystemPrompt };
    }
    if (options.mainThreadAgentDefinition) {
      return {
        source: 'agent',
        fixedBody: options.mainThreadAgentDefinition.getSystemPrompt(),
      };
    }
    if (options.customSystemPrompt !== undefined) {
      return { source: 'custom', fixedBody: options.customSystemPrompt };
    }
    return { source: 'default' };
  }),
  toTranscriptWorktreeSession: vi.fn((settings, sessionId) => ({
    originalCwd: settings.originalCwd,
    preEnterOriginalCwd: settings.originalCwd,
    worktreePath: settings.path,
    worktreeCwd: settings.worktreeCwd,
    worktreeName: settings.name,
    worktreeBranch: settings.worktreeBranch,
    originalBranch: settings.originalBranch,
    originalHeadCommit: settings.originalHeadCommit,
    sessionId: settings.sessionId ?? sessionId,
    lifecycle: settings.lifecycle,
    hookBased: settings.hookBased,
    enteredExisting: settings.enteredExisting,
  })),
  runLogger: {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  },
  sessionIdContext: {
    run: vi.fn((_sessionId, callback) => callback()),
  },
  seedStartupStaticMemoryFileReadState: vi.fn(),
  startupTaskId: vi.fn((taskId: string) => taskId),
  setCwd: vi.fn((cwd: string) => {
    coreMocks.cwd = cwd;
  }),
  runWithWorkspaceTransition: <T>(
    config: Config,
    operation: () => Promise<T>,
  ) => runWithWorkspaceTransition(config, operation),
  setOriginalCwd: vi.fn((cwd: string) => {
    coreMocks.originalCwd = cwd;
  }),
  stripThoughtSignaturesFromMessages: vi.fn((messages) => messages),
  uiTelemetryService: {
    clear: vi.fn(),
    getLastPromptTokenCount: vi.fn(() => 0),
    hydrateFromMessages: vi.fn(),
    setLastPromptTokenCount: vi.fn(),
  },
}));

vi.mock('../../utils/applyResumeWorktreeState.js', () => ({
  applyResumeWorktreeState: coreMocks.applyResumeWorktreeState,
}));

vi.mock('../../session/rootToolRegistry.js', () => ({
  RootToolRegistry: class {
    registerTool = rootToolRegistryMocks.registerTool;
    unregisterTool = rootToolRegistryMocks.unregisterTool;

    constructor(_config: Config, mainRegistryProvider: unknown) {
      rootToolRegistryMocks.mainRegistryProviders.push(mainRegistryProvider);
    }
  },
}));

vi.mock('../../session/artifacts/presentFilesTool.js', () => ({
  PresentFilesTool: class {
    readonly name = 'mcp__qw-builtin__present_files';
    constructor(readonly present: unknown) {}
  },
}));

vi.mock('../../session/artifacts/artifactProtocol.js', () => ({
  PRESENT_FILES_TOOL_NAME: 'mcp__qw-builtin__present_files',
}));

vi.mock('../../config/externalImportApproval.js', () => ({
  approveExternalImportsForProject: mockApproveExternalImportsForProject,
}));

vi.mock('../components/ExternalImportApprovalDialog.js', () => ({
  ExternalImportApprovalChoice: {
    APPROVE: 'approve',
    ALWAYS_APPROVE: 'always_approve',
    REJECT: 'reject',
  },
}));

vi.mock('../components/messages/HookAttachmentMessage.js', () => ({
  buildHookAttachmentHistoryItem: vi.fn(() => null),
  isStopHookEvent: vi.fn(() => false),
}));

vi.mock('../components/messages/StopHookSummaryMessage.js', () => ({
  buildStopHookSummaryHistoryItem: vi.fn(() => null),
}));

vi.mock('./useRuntimeProjection.js', () => ({
  formatSupplementarySystemContent: vi.fn((content: string) => content),
}));

describe('buildBashCommandProcessResult', () => {
  it('does not query the model after a foreground command by default', () => {
    const result = buildBashCommandProcessResult({
      kind: 'completed',
      command: 'echo 2',
      displayOutput: '2',
      modelOutput: { stdout: '2', stderr: '' },
      exitCode: 0,
      signal: null,
    });

    expect(result.shouldQuery).toBe(false);
  });

  it('continues the model query after a foreground command completes', () => {
    const result = buildBashCommandProcessResult(
      {
        kind: 'completed',
        command: 'echo 2',
        displayOutput: '2',
        modelOutput: { stdout: '2', stderr: 'warning' },
        exitCode: 1,
        signal: null,
      },
      true,
    );

    expect(result.shouldQuery).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      message: { content: [{ text: '<bash-input>echo 2</bash-input>' }] },
    });
    expect(result.messages[1]).toMatchObject({
      message: {
        content: [
          {
            text: '<bash-stdout>2</bash-stdout><bash-stderr>warning</bash-stderr>',
          },
        ],
      },
    });
  });

  it('records a completed command without querying when responses are disabled', () => {
    const result = buildBashCommandProcessResult(
      {
        kind: 'completed',
        command: 'echo 2',
        displayOutput: '2',
        modelOutput: { stdout: '2', stderr: '' },
        exitCode: 0,
        signal: null,
      },
      false,
    );

    expect(result.shouldQuery).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({
      uuid: 'synthetic-user-message',
    });
    expect(result.messages[1]).toMatchObject({
      message: { content: [{ text: '<bash-input>echo 2</bash-input>' }] },
    });
    expect(result.messages[2]).toMatchObject({
      message: {
        content: [
          { text: '<bash-stdout>2</bash-stdout><bash-stderr></bash-stderr>' },
        ],
      },
    });
  });

  it.each([
    {
      kind: 'backgrounded' as const,
      command: 'sleep 30',
      pid: 123,
      displayOutput: 'backgrounded',
      modelOutput: { stdout: '', stderr: '' },
    },
    {
      kind: 'cancelled' as const,
      command: 'sleep 30',
      displayOutput: 'cancelled',
      modelOutput: { stdout: '', stderr: 'cancelled' },
      timedOut: false,
    },
  ])('records $kind commands without querying the model', (outcome) => {
    const result = buildBashCommandProcessResult(outcome);

    expect(result.shouldQuery).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({
      uuid: 'synthetic-user-message',
    });
  });
});

describe('isChildScopedQueryEvent', () => {
  it('returns false for top-level stream events', () => {
    expect(
      isChildScopedQueryEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '正文' },
        },
      }),
    ).toBe(false);
  });

  it('returns true for child stream events', () => {
    expect(
      isChildScopedQueryEvent({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '正文' },
        },
        parent_tool_use_id: 'toolu-parent-1',
      }),
    ).toBe(true);
  });

  it('returns true for child assistant messages', () => {
    expect(
      isChildScopedQueryEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu-parent-1',
        uuid: 'assistant-1',
        sessionId: 'session-1',
        timestamp: '2026-04-24T00:00:00.000Z',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: 'auto',
          content: [{ type: 'text', text: 'child reply' }],
          stop_reason: 'end_turn',
          usage: { ...cloneUsage(), input_tokens: 1, output_tokens: 1 },
        },
      }),
    ).toBe(true);
  });
});

describe('createRuntimeMessageUuidDeduplicator', () => {
  it('indexes appended messages and rebuilds after history replacement', () => {
    let messages = [{ uuid: 'existing' }] as Message[];
    const isDuplicate = createRuntimeMessageUuidDeduplicator(() => messages);

    expect(isDuplicate({ uuid: 'existing' })).toBe(true);
    expect(isDuplicate({ uuid: 'new-event' })).toBe(false);
    expect(isDuplicate({ uuid: 'new-event' })).toBe(true);

    messages.push({ uuid: 'external-append' } as Message);
    expect(isDuplicate({ uuid: 'external-append' })).toBe(true);

    messages = [{ uuid: 'replacement' }] as Message[];
    expect(isDuplicate({ uuid: 'new-event' })).toBe(false);
    expect(isDuplicate({ uuid: 'replacement' })).toBe(true);
  });

  it('does not deduplicate messages without a UUID', () => {
    const isDuplicate = createRuntimeMessageUuidDeduplicator(() => []);

    expect(isDuplicate({})).toBe(false);
    expect(isDuplicate({})).toBe(false);
  });
});

describe('useLocalTuiSessionOrchestrator worktree resume rebinding', () => {
  const originalCwd = process.cwd();

  beforeEach(async () => {
    const { initializeI18nService } = await import(
      '../../../../core/src/i18n/index.js'
    );
    initializeI18nService();
    coreMocks.compressionPipelineInstances.length = 0;
    builtinPluginMocks.promptSuggestionContributions.mockReset();
    builtinPluginMocks.promptSuggestionContributions.mockReturnValue([]);
    rootToolRegistryMocks.registerTool.mockReset();
    rootToolRegistryMocks.unregisterTool.mockReset();
    rootToolRegistryMocks.mainRegistryProviders.length = 0;
    coreMocks.fileHistoryManagerInstances.length = 0;
    coreMocks.rehydrateFileHistory.mockReset();
    coreMocks.rehydrateFileHistory.mockResolvedValue(undefined);
    coreMocks.promptAssemblerContexts.length = 0;
    coreMocks.bindSessionUsagePersistence.mockReset();
    coreMocks.bindSessionUsagePersistence.mockResolvedValue(
      async () => undefined,
    );
    coreMocks.flushSessionUsage.mockReset();
    coreMocks.flushSessionUsage.mockResolvedValue(undefined);
    coreMocks.executeConversationRewind.mockReset();
    coreMocks.executeConversationRewind.mockImplementation(
      async ({ targetUuid, writer, adapter }) => {
        // Mirrors the core contract: a missing transcript writer is rejected
        // before the target is even looked up.
        if (!writer) {
          throw Object.assign(
            new Error(
              'Conversation Rewind requires an active transcript writer.',
            ),
            { code: 'not-ready' },
          );
        }
        const before = adapter.readState();
        adapter.assertReady(before);
        const targetIndex = before.messages.findIndex(
          (message: Message) => message.uuid === targetUuid,
        );
        if (targetIndex < 0) {
          throw Object.assign(new Error('target not found'), {
            code: 'target-not-found',
          });
        }
        const retainedMessages = before.messages.slice(0, targetIndex);
        const retainedLeafUuid = retainedMessages.at(-1)?.uuid ?? null;
        const plan = {
          target: {
            message: before.messages[targetIndex],
            displayText: targetUuid,
            prefillText: targetUuid,
            inputMode: 'prompt',
          },
          retainedMessages,
          retainedLeafUuid,
        };
        await writer.recordActiveLeaf(retainedLeafUuid, {
          explicit: true,
          rewound: true,
          durable: true,
        });
        try {
          const current = adapter.readState();
          adapter.assertReady(current);
          const unchanged =
            current.sessionId === before.sessionId &&
            current.leafUuid === before.leafUuid &&
            current.guardRevision === before.guardRevision &&
            current.messages.length === before.messages.length &&
            current.messages.every(
              (message: Message, index: number) =>
                message.uuid === before.messages[index]?.uuid,
            );
          if (!unchanged) {
            throw Object.assign(new Error('state changed'), {
              code: 'state-changed',
            });
          }
          adapter.commit(plan);
          return plan;
        } catch (error) {
          adapter.restore();
          await writer.recordActiveLeaf(before.leafUuid, {
            explicit: true,
            rewound: false,
            durable: true,
          });
          throw error;
        }
      },
    );
    coreMocks.sessionStateStoreInstances.length = 0;
    coreMocks.setWorkspaceDirectoriesImpl.mockReset();
    coreMocks.setWorkspaceDirectoriesImpl.mockResolvedValue(undefined);
    coreMocks.transcriptWriterInstances.length = 0;
    coreMocks.restoreInvokedSkillsFromTranscript.mockReset();
    coreMocks.getPromptSuggestionFeatureConfig.mockReset();
    coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
      enabled: true,
      mode: 'legacy',
      forkEnabled: false,
    });
    coreMocks.subscribePromptSuggestionFeatureGate.mockReset();
    coreMocks.subscribePromptSuggestionFeatureGate.mockReturnValue(undefined);
    coreMocks.tryGeneratePromptSuggestion.mockReset();
    coreMocks.tryGeneratePromptSuggestion.mockResolvedValue(null);
    coreMocks.capturePromptSuggestionForkSource.mockReset();
    mockApproveExternalImportsForProject.mockReset().mockReturnValue(true);
    vi.mocked(createAttachmentContext).mockClear();
    vi.mocked(generateSessionTitleForCurrentSession).mockReset();
    vi.mocked(generateSessionTitleForCurrentSession).mockResolvedValue(
      undefined,
    );
    coreMocks.applyResumeWorktreeState.mockReset();
    coreMocks.applyResumeWorktreeState.mockImplementation(
      async (_config, state, record) => {
        if (!state) {
          await record(null);
          return {
            status: 'ordinary',
            worktreeSession: null,
            acceptLegacyFileHistorySnapshots: true,
          };
        }
        await record(state);
        return {
          status: 'restored',
          worktreeSession: state,
          acceptLegacyFileHistorySnapshots: false,
        };
      },
    );
    vi.mocked(isChainParticipant).mockReset();
    vi.mocked(isChainParticipant).mockReturnValue(false);
    vi.mocked(query).mockReset();
    vi.mocked(query).mockImplementation(async function* (_options: unknown) {
      // Preserve the async-generator query mock shape while satisfying require-yield.
      yield* [];
      return { reason: 'end_turn' };
    } as never);
    vi.mocked(parseAndFormatApiErrorMessage).mockReset();
    vi.mocked(parseAndFormatApiErrorMessage).mockImplementation((message) =>
      String(message),
    );
    vi.mocked(materializePastedContents).mockClear();
    vi.mocked(processPastedImages).mockReset();
    vi.mocked(applyMcpLazyLoad).mockReset();
    vi.mocked(applyMcpLazyLoad).mockResolvedValue(undefined as never);
    vi.mocked(getAttachmentMessages).mockReset();
    vi.mocked(getAttachmentMessages).mockResolvedValue([]);
    vi.mocked(getSkillListingConfig).mockReset().mockResolvedValue({});
    vi.mocked(getModelVisibleSkillsForTools).mockReset().mockReturnValue([]);
    vi.mocked(executeUserInput).mockReset();
    vi.mocked(isCommandStyleUserPromptText).mockReset();
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(false);
    vi.mocked(seedStartupStaticMemoryFileReadState).mockReset();
    vi.mocked(seedStartupStaticMemoryFileReadState).mockReturnValue(0);
  });

  afterEach(() => {
    fixtureFileWatcher.disposeFileChangedWatcher();
    process.chdir(originalCwd);
  });

  function createDirs() {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'qwen-resume-'));
    const mainRoot = nodePath.join(root, 'main');
    const oldWorktreeRoot = nodePath.join(root, 'worktree-old');
    const oldWorktreeChild = nodePath.join(oldWorktreeRoot, 'pkg');
    const targetWorktreeRoot = nodePath.join(root, 'worktree-target');
    const targetWorktreeChild = nodePath.join(targetWorktreeRoot, 'pkg');
    const extraRoot = nodePath.join(root, 'extra');
    const oldWorktreeChildLink = nodePath.join(root, 'worktree-pkg-link');

    mkdirSync(mainRoot, { recursive: true });
    mkdirSync(oldWorktreeChild, { recursive: true });
    mkdirSync(targetWorktreeChild, { recursive: true });
    mkdirSync(extraRoot, { recursive: true });
    symlinkSync(oldWorktreeChild, oldWorktreeChildLink, 'dir');

    return {
      extraRoot,
      mainRoot,
      oldWorktreeChild,
      oldWorktreeChildLink,
      oldWorktreeRoot,
      targetWorktreeChild,
      targetWorktreeRoot,
    };
  }

  function mockSuccessfulAssistantTurns(config: Config) {
    let turnIndex = 0;
    vi.mocked(isTitleEligibleAssistantMessage).mockReturnValue(true);
    vi.mocked(query).mockImplementation(async function* () {
      turnIndex += 1;
      const messageId = `assistant-title-response-${turnIndex}`;
      yield {
        type: 'assistant',
        uuid: messageId,
        sessionId: config.getSessionId(),
        timestamp: '2026-07-23T00:00:00.000Z',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: 'test-model',
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: { ...cloneUsage(), input_tokens: 1, output_tokens: 1 },
        },
      } as Message;
      return { reason: 'end_turn' };
    } as never);
  }

  it('passes a branch source to every TUI query in the current process', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(query).mockImplementation(async function* () {
      yield { type: 'request_start' };
      return { reason: 'end_turn' };
    } as never);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], 'fork-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      sourceSessionId: 'source-session',
      transcriptProjectRoot: mainRoot,
    });

    await result.current.submitQuery('first fork prompt');
    await result.current.submitQuery('later prompt');

    expect(vi.mocked(query).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ sourceSessionId: 'source-session' }),
    );
    expect(vi.mocked(query).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ sourceSessionId: 'source-session' }),
    );

    // A plain resume carries no source session, which clears the fork source.
    await result.current.replaceMessages([], 'resumed-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: mainRoot,
    });
    await result.current.submitQuery('ordinary resumed prompt');

    expect(vi.mocked(query).mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ sourceSessionId: undefined }),
    );
  });

  // createDirs() 在 Windows 上需要创建 worktree symlink，受限环境会 EPERM。
  it.skipIf(process.platform === 'win32')(
    'does not persist file history for a prewritten fork transcript',
    async () => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const { result } = await renderOrchestrator(config);

      await result.current.replaceMessages([], 'fork-session', {
        restoreExistingSession: true,
        setConfigSessionId: true,
        sourceSessionId: 'source-session',
        transcriptProjectRoot: mainRoot,
        fileHistorySnapshots: [],
        persistFileHistoryToTranscript: false,
      });

      expect(coreMocks.rehydrateFileHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSessionId: 'source-session',
          persistToTranscript: false,
        }),
      );
    },
  );

  it('persists external import approval for the original project while running in a worktree', async () => {
    const { mainRoot, targetWorktreeChild, targetWorktreeRoot } = createDirs();
    const { config } = createConfig({
      directories: [targetWorktreeChild],
      targetDir: targetWorktreeChild,
      worktreeSettings: createWorktreeSettings(targetWorktreeRoot, mainRoot),
    });
    const loadedSettings = { merged: {} } as LoadedSettings;
    config.getLoadedSettings = vi.fn(() => loadedSettings);
    process.chdir(targetWorktreeChild);
    const { result } = await renderOrchestrator(config);

    result.current.handleExternalImportApproval({
      choice: 'always_approve' as never,
    });

    expect(mockApproveExternalImportsForProject).toHaveBeenCalledWith(
      mainRoot,
      loadedSettings,
    );
  });

  it('does not resolve external imports when permanent approval cannot be saved', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    config.getLoadedSettings = vi.fn(() => ({ merged: {} }) as LoadedSettings);
    mockApproveExternalImportsForProject.mockReturnValueOnce(false);
    const { result } = await renderOrchestrator(config);
    const resolveImports =
      config.getMemoryContextManager()!.resolveExternalImports;
    vi.mocked(resolveImports).mockClear();

    result.current.handleExternalImportApproval({
      choice: 'always_approve' as never,
    });

    expect(resolveImports).not.toHaveBeenCalled();
  });

  function createWorkspaceContext(
    directories: string[],
    options: { failSetDirectoriesOnce?: boolean } = {},
  ) {
    let currentDirectories = [...directories];
    let shouldFail = options.failSetDirectoriesOnce === true;
    const workspaceContext = {
      addReadOnlyPath: vi.fn(),
      addDirectories: vi.fn((directories: readonly string[]) => {
        currentDirectories = [
          ...new Set([...currentDirectories, ...directories]),
        ];
        return { added: directories, failed: [] };
      }),
      getDirectories: vi.fn(() => [...currentDirectories]),
      setDirectories: vi.fn((nextDirectories: readonly string[]) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('setDirectories failed');
        }
        currentDirectories = [...nextDirectories];
      }),
    };
    return workspaceContext;
  }

  function createConfig(options: {
    directories: string[];
    targetDir: string;
    worktreeSettings?: WorktreeSettings;
    failSetDirectoriesOnce?: boolean;
    fileHistoryManager?: FileHistoryManager;
  }) {
    let targetDir = options.targetDir;
    let workingDir = options.targetDir;
    let sessionId = 'current-session';
    let worktreeSettings = options.worktreeSettings;
    let fileHistoryManager = options.fileHistoryManager;
    let promptAssembler: { clearCache: ReturnType<typeof vi.fn> } | undefined =
      {
        clearCache: vi.fn(),
      };
    const startupRuntime = {
      onReady: vi.fn(() => vi.fn()),
    };
    const workspaceContext = createWorkspaceContext(options.directories, {
      failSetDirectoriesOnce: options.failSetDirectoriesOnce,
    });
    const memoryContextManager = {
      getUserContext: vi.fn(() => undefined),
      resolveExternalImports: vi.fn(async () => undefined),
      restoreJitPathsFromMessages: vi.fn(),
    };
    const modelManager = {
      getModel: vi.fn(async (key: string) => testModelResolution(key).model),
      getModelConfig: vi.fn((): ModelConfig | undefined => undefined),
      listModels: vi.fn(async () => []),
      select: vi.fn((input: ModelSelectContext) =>
        fixedSelection('test-model').resolve(input),
      ),
    };
    const toolExecutor = new StreamingToolExecutor();
    const config = {
      getToolExecutor: vi.fn(() => toolExecutor),
      getContentGeneratorConfig: vi.fn(() => ({ authType: 'qoder-browser' })),
      getProcessPermissionManager: vi.fn(() => undefined),
      getBuiltinPluginContributions: vi.fn(() => undefined),
      getAppendSystemPrompt: vi.fn(() => undefined),
      getCustomSystemPrompt: vi.fn(() => undefined),
      getEffectiveContextWindow: vi.fn(() => 128_000),
      getFileCheckpointingEnabled: vi.fn(() => true),
      getAgentRegistry: vi.fn(() => undefined),
      getFileHistoryManager: vi.fn(() => fileHistoryManager),
      getHookSystem: vi.fn(() => undefined),
      getMcpClientManager: vi.fn(() => undefined),
      getMemoryContextManager: vi.fn(() => memoryContextManager),
      getModel: vi.fn(() => 'test-model'),
      getModelRequestIdentity: vi.fn(() => 'test-account'),
      getModelProviderManager: vi.fn(() => modelManager),
      hasModelProviderManager: vi.fn(() => true),
      getPermission: vi.fn(() => undefined),
      getPermissionMode: vi.fn(() => 'default'),
      getPermissionModeRestriction: vi.fn(() => undefined),
      getProjectRoot: vi.fn(() => targetDir),
      getSessionArtifactProjectRoot: vi.fn(
        () => worktreeSettings?.originalCwd ?? targetDir,
      ),
      getPromptAssembler: vi.fn(() => promptAssembler),
      getProxy: vi.fn(() => undefined),
      getSessionAgentDefinitionLike: vi.fn(() => undefined),
      getSessionId: vi.fn(() => sessionId),
      getSkillListingBudgetFraction: vi.fn(() => undefined),
      getSkillListingMaxDescChars: vi.fn(() => undefined),
      getSkillManager: vi.fn(() => ({
        getModelVisibleSkills: vi.fn(() => []),
      })),
      getSkillVisibilityOverrides: vi.fn(() => undefined),
      getStartupRuntime: vi.fn(() => startupRuntime),
      getTaskStore: vi.fn(() => undefined),
      getTranscriptStore: vi.fn(() => ({
        acquireSessionWriter: vi.fn(
          async (args: {
            cwd: string;
            filePath: string;
            sessionId: string;
          }) => {
            const writer = {
              args,
              adoptMainParentUuid: vi.fn(),
              close: vi.fn(async () => undefined),
              getSessionId: () => args.sessionId,
              getSessionFilePath: () => args.filePath,
              relocate: vi.fn(async () => undefined),
              recordActiveLeaf: vi.fn(async () => undefined),
              recordAiTitle: vi.fn(async () => undefined),
              recordCustomTitle: vi.fn(async () => undefined),
              recordFileHistorySnapshot: vi.fn(async () => undefined),
              recordMessages: vi.fn(
                async (messages: Message[]) => messages.at(-1)?.uuid ?? null,
              ),
              recordRuntimeConfig: vi.fn(async () => undefined),
              recordTokenStats: vi.fn(async () => undefined),
              recordWorktreeState: vi.fn(async () => undefined),
            };
            coreMocks.transcriptWriterInstances.push(writer);
            return writer;
          },
        ),
      })),
      getTargetDir: vi.fn(() => targetDir),
      getToolRegistry: vi.fn(() => ({
        hasToolEnabled: vi.fn(() => true),
        getSchema: vi.fn(() => []),
      })),
      getWorkingDir: vi.fn(() => workingDir),
      getWorkflowKeywordTriggerEnabled: vi.fn(() => false),
      getWorkspaceContext: vi.fn(() => workspaceContext),
      getWorktreeSettings: vi.fn(() => worktreeSettings),
      isTasksEnabled: vi.fn(() => false),
      isUltracodeActive: vi.fn(() => false),
      // Base initialization is complete by default: the tool registry exists
      // and the turn prompt resolver can be built eagerly, matching the
      // post-startup state every other test in this file assumes.
      isInitialized: vi.fn(() => true),
      waitForStartupGate: vi.fn(async () => ({ status: 'ready' as const })),
      onSkillChange: vi.fn(() => vi.fn()),
      persistSessionTitle: vi.fn(async () => undefined),
      refreshRuntimeWorkspaceServices: vi.fn(),
      synchronizeWorktreeRuntimeState: vi.fn(),
      planStateManager: {
        getPlanFilePath: vi.fn(() => 'plan.md'),
      },
      registerForkContextAccessors: vi.fn(),
      registerSessionRuntimeBinding: vi.fn(),
      setTurnInterrupt: vi.fn(),
      setFileHistoryManager: vi.fn(
        (manager: FileHistoryManager | undefined) => {
          fileHistoryManager = manager;
        },
      ),
      setSessionId: vi.fn((nextSessionId: string) => {
        sessionId = nextSessionId;
      }),
      setPromptAssembler: vi.fn((assembler) => {
        promptAssembler = assembler;
      }),
      setTargetDir: vi.fn((dir: string) => {
        targetDir = nodePath.resolve(dir);
      }),
      setWorkingDir: vi.fn((dir: string) => {
        workingDir = nodePath.resolve(dir);
      }),
      setWorktreeSettings: vi.fn((settings: WorktreeSettings | undefined) => {
        worktreeSettings = settings;
      }),
      storage: {
        getPlansDir: vi.fn(() => nodePath.join(targetDir, '.plans')),
        getProjectTempDir: vi.fn(() => nodePath.join(targetDir, '.tmp')),
      },
      topicState: {
        setTopic: vi.fn(),
        getTopic: vi.fn(() => undefined),
      },
    } as unknown as Config;

    const sessionManager = withSessionSelection(modelManager, config);
    vi.mocked(config.getModelProviderManager).mockReturnValue(
      sessionManager as unknown as ReturnType<
        Config['getModelProviderManager']
      >,
    );
    return {
      config,
      modelManager,
      memoryContextManager,
      startupRuntime,
      workspaceContext,
    };
  }

  function createWorktreeSettings(path: string, originalCwd: string) {
    return {
      baseSha: 'base-sha',
      name: 'old-worktree',
      originalCwd,
      path,
      sessionId: 'current-session',
      worktreeCwd: path,
      worktreeBranch: 'feature/old',
      lifecycle: 'owner',
    } satisfies WorktreeSettings;
  }

  it('returns partial file rewind so the caller can complete conversation rewind', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);
    vi.mocked(config.getFileHistoryManager).mockReturnValue({
      rewindDetailed: async () => ({
        filesChanged: ['a.ts'],
        failedFiles: [{ path: 'b.ts', error: 'missing backup' }],
      }),
    } as unknown as FileHistoryManager);
    try {
      await expect(result.current.rewindFiles('checkpoint')).resolves.toEqual({
        filesChanged: ['a.ts'],
        failedFiles: [{ path: 'b.ts', error: 'missing backup' }],
      });
    } finally {
      unmount();
    }
  });

  async function renderOrchestrator(
    config: Config,
    overrides: {
      addItem?: ReturnType<typeof vi.fn>;
      awaitSessionStartHooks?: (signal?: AbortSignal) => Promise<void>;
      onCancelSubmit?: ReturnType<typeof vi.fn>;
      onLocalUserMessage?: ReturnType<typeof vi.fn>;
      onProvisionalSessionTitle?: ReturnType<typeof vi.fn>;
      onPromptSuggestions?: ReturnType<typeof vi.fn>;
      onStartupWaitingChange?: ReturnType<typeof vi.fn>;
      onTurnComplete?: ReturnType<typeof vi.fn>;
      onCoreEvent?: ReturnType<typeof vi.fn>;
      onSlashCommand?: ReturnType<typeof vi.fn>;
      onBashCommand?: ReturnType<typeof vi.fn>;
      initialConversationHistory?: Message[];
      deferInitialTranscriptWriter?: boolean;
      promptSuggestionEnabled?: boolean;
      respondToBashCommands?: boolean;
      maxTurns?: 1000 | 2000 | 3000 | 'unlimited';
      runtimeProjection?: RuntimeProjectionController;
    } = {},
  ) {
    let orchestrator: LocalTuiSessionOrchestratorResult | undefined;
    const addItem = overrides.addItem ?? vi.fn();
    const onCancelSubmit = overrides.onCancelSubmit ?? vi.fn();
    const runtimeProjection =
      overrides.runtimeProjection ?? NOOP_RUNTIME_PROJECTION;
    const mergedSettings = {
      security: {
        auth: { selectedType: AuthType.QODER_BROWSER },
      },
      promptSuggestionEnabled: overrides.promptSuggestionEnabled ?? true,
      respondToBashCommands: overrides.respondToBashCommands ?? false,
      ui: { maxTurns: overrides.maxTurns },
    };
    function TestComponent() {
      orchestrator = useLocalTuiSessionOrchestrator({
        addItem,
        deferInitialTranscriptWriter: overrides.deferInitialTranscriptWriter,
        awaitSessionStartHooks: overrides.awaitSessionStartHooks,
        config,
        focusMachine: null,
        getPreferredEditor: () => undefined,
        onCancelSubmit,
        onLocalUserMessage: overrides.onLocalUserMessage,
        onProvisionalSessionTitle: overrides.onProvisionalSessionTitle,
        onPromptSuggestions: overrides.onPromptSuggestions,
        onStartupWaitingChange: overrides.onStartupWaitingChange,
        onTurnComplete: overrides.onTurnComplete,
        onCoreEvent: overrides.onCoreEvent,
        onSlashCommand: overrides.onSlashCommand,
        onBashCommand: overrides.onBashCommand,
        initialConversationHistory: overrides.initialConversationHistory,
        runtimeProjectionRef: {
          current: runtimeProjection,
        } as MutableRefObject<RuntimeProjectionController>,
        settings: {
          merged: mergedSettings,
        } as unknown as LoadedSettings,
        version: 'test-version',
      });
      return null;
    }

    renderToString(React.createElement(TestComponent));
    if (!orchestrator) {
      throw new Error('orchestrator did not render');
    }

    return {
      addItem,
      mergedSettings,
      onCancelSubmit,
      result: { current: orchestrator },
      unmount: () => undefined,
    };
  }

  it('owns one lazy session handle and releases it on native shutdown, not UI unbinding', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const rendered = await renderHook(() =>
      useLocalTuiSessionOrchestrator({
        config,
        addItem: vi.fn(),
        focusMachine: null,
        getPreferredEditor: () => undefined,
        onCancelSubmit: vi.fn(),
        runtimeProjectionRef: { current: NOOP_RUNTIME_PROJECTION },
        settings: {
          merged: {
            security: { auth: { selectedType: AuthType.QODER_BROWSER } },
          },
        } as LoadedSettings,
        version: 'test',
      }),
    );
    const handle = rendered.result.current.getSession();
    expect(rendered.result.current.getSession()).toBe(handle);
    await handle.start();
    const end = vi.spyOn(handle, 'end');
    const binding = createSessionUiBinding(handle, 'local');
    await binding.dispose();
    expect(handle.getState().access.status).toBe('connected');
    const execution = vi.fn();
    const messages = vi.fn();
    handle.observeExecution(execution);
    handle.observe(messages);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [
        {
          type: 'user',
          uuid: 'native-owned-input',
          message: { role: 'user', content: 'continue' },
        } as Message,
      ],
      shouldQuery: true,
    });
    vi.mocked(query).mockImplementationOnce(async function* () {
      yield { type: 'request_start' };
      return { reason: 'end_turn' };
    } as never);
    await React.act(async () =>
      handle.submitMessage({
        id: 'native-owned-input',
        text: 'continue',
        content: [{ type: 'text', text: 'continue' }],
      }),
    );
    expect(query).toHaveBeenCalledOnce();
    expect(execution).toHaveBeenCalledWith({
      type: 'query_event',
      event: { type: 'request_start' },
    });
    expect(execution).toHaveBeenCalledWith({ type: 'turn_complete' });
    expect(
      messages.mock.calls.filter(
        ([change]) => change.type === 'input_prepared',
      ),
    ).toHaveLength(1);
    await React.act(async () => {
      await rendered.result.current.dispose();
    });
    expect(handle.getState().access.status).toBe('disconnected');
    await expect(handle.resume()).rejects.toThrow('ended');
    await React.act(async () => rendered.unmount());
    expect(handle.getState().access.status).toBe('disconnected');
    expect(end).not.toHaveBeenCalled();
  });

  async function replaceMessages(
    result: { current: LocalTuiSessionOrchestratorResult },
    sessionId: string,
    options: {
      restoreExistingSession: true;
      setConfigSessionId?: boolean;
      targetWorkspaceDirectories?: readonly string[];
      transcriptProjectRoot?: string;
      worktreeSession?:
        | import('@qwen-code/core').TranscriptWorktreeSession
        | null;
    },
  ) {
    await result.current.replaceMessages([] as Message[], sessionId, options);
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function rewindMessages(): Message[] {
    return [
      {
        type: 'user',
        uuid: 'user-a',
        timestamp: '2026-08-04T00:00:00.000Z',
        message: { role: 'user', content: 'A' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-a',
        timestamp: '2026-08-04T00:00:01.000Z',
        message: { role: 'assistant', content: [] },
      } as unknown as Message,
      {
        type: 'user',
        uuid: 'user-b',
        timestamp: '2026-08-04T00:00:02.000Z',
        message: { role: 'user', content: 'B' },
      },
    ] as Message[];
  }

  it('waits for the active writer to close and shares one shutdown across project replacement and unmount', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    const close = deferred<void>();
    writer.close.mockImplementation(() => close.promise);
    const pending = result.current.dispose();
    expect(result.current.dispose()).toBe(pending);
    await waitFor(() => expect(writer.close).toHaveBeenCalled());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    unmount();
    close.resolve();
    await pending;
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'waits for worktree resume to settle before closing its writers (failure=%s)',
    async (failResume) => {
      const { mainRoot, targetWorktreeRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const { result } = await renderOrchestrator(config);
      await result.current.replaceMessages([], 'current-session', {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      });
      const previousWriter = coreMocks.transcriptWriterInstances.at(-1)!;
      coreMocks.applyResumeWorktreeState.mockImplementationOnce(
        async (config, state, recordWorktreeState) => {
          const outcome = await worktreeSessionService.restore(
            {
              config,
              sessionId: config.getSessionId(),
              phase: 'restore',
              recordWorktreeState,
            },
            state,
          );
          if (outcome.status !== 'restored')
            throw new Error(JSON.stringify(outcome));
          return {
            status: 'restored',
            worktreeSession: state,
            acceptLegacyFileHistorySnapshots: false,
          };
        },
      );
      const entered = deferred<void>();
      const gate = deferred<void>();
      coreMocks.rehydrateFileHistory.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        if (failResume) throw new Error('rehydration failed');
      });
      const resume = result.current.replaceMessages([], 'next-session', {
        restoreExistingSession: true,
        setConfigSessionId: true,
        transcriptProjectRoot: mainRoot,
        fileHistorySnapshots: [],
        worktreeSession: {
          sessionId: 'next-session',
          worktreeName: 'target',
          worktreePath: targetWorktreeRoot,
          worktreeCwd: targetWorktreeRoot,
          originalCwd: mainRoot,
          hookBased: true,
          lifecycle: 'attached',
        },
      });
      const completion = resume.then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.race([
        entered.promise,
        completion.then((error) => {
          if (error) throw error;
        }),
      ]);
      const nextWriter = coreMocks.transcriptWriterInstances.at(-1)!;
      let disposed = false;
      const shutdown = result.current.dispose().then(() => {
        disposed = true;
      });
      try {
        // 允许关闭流程推进，但保留 Resume 的异步边界，验证资源不能提前关闭。
        await new Promise((resolve) => setImmediate(resolve));
        expect(disposed).toBe(false);
        expect(nextWriter.close).not.toHaveBeenCalled();
        expect(previousWriter.close).not.toHaveBeenCalled();
        gate.resolve();
        const error = await completion;
        await shutdown;
        expect(error).toEqual(
          failResume ? new Error('rehydration failed') : undefined,
        );
        expect(nextWriter.close).toHaveBeenCalled();
        expect(previousWriter.close).toHaveBeenCalled();
        const finalSessionId = config.getSessionId();
        await expect(
          result.current.replaceMessages([], 'after-disposal', {
            setConfigSessionId: true,
          }),
        ).rejects.toThrow(/closing|disposed/i);
        expect(config.getSessionId()).toBe(finalSessionId);
      } finally {
        gate.resolve();
        await Promise.allSettled([completion, shutdown]);
      }
    },
  );

  it('does not create a default-bucket transcript before initial resume opens the selected legacy path', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config, {
      deferInitialTranscriptWriter: true,
    });
    expect(coreMocks.transcriptWriterInstances).toEqual([]);
    const sessionPath = nodePath.join(mainRoot, 'legacy', 'selected.jsonl');
    await result.current.replaceMessages([], 'selected', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: mainRoot,
      sessionPath,
    });
    expect(
      coreMocks.transcriptWriterInstances.map((writer) => writer.args.filePath),
    ).toEqual([sessionPath]);
    unmount();
  });

  it.each([false, true])(
    'persists the initial title to the target transcript (deferred resume: %s)',
    async (deferInitialTranscriptWriter) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const store = new TranscriptStore({
        coordinatorOptions: { flushIntervalMs: 0 },
      });
      vi.mocked(config.getTranscriptStore).mockReturnValue(store);
      // Exercise the registered callback instead of treating persistence as a
      // no-op, so this test covers the writer's publication order.
      vi.mocked(config.persistSessionTitle).mockImplementation(
        async (title) => {
          const binding = vi
            .mocked(config.registerSessionRuntimeBinding)
            .mock.calls.map(([value]) => value)
            .findLast((value) => value !== undefined);
          expect(binding?.persistSessionTitle).toBeDefined();
          await binding?.persistSessionTitle?.(title.trim());
        },
      );
      const onLocalSessionTitle = vi.fn();
      const { result, unmount } = await renderHook(() =>
        useLocalTuiSessionOrchestrator({
          addItem: vi.fn(),
          config,
          deferInitialTranscriptWriter,
          initialSessionTitle: 'Named session',
          onLocalSessionTitle,
          focusMachine: null,
          getPreferredEditor: () => undefined,
          onCancelSubmit: vi.fn(),
          runtimeProjectionRef: { current: NOOP_RUNTIME_PROJECTION },
          settings: {
            merged: {
              security: { auth: { selectedType: AuthType.QODER_BROWSER } },
            },
          } as unknown as LoadedSettings,
          version: 'test-version',
        }),
      );
      const sessionId = deferInitialTranscriptWriter
        ? 'selected-session'
        : config.getSessionId();
      const filePath = nodePath.join(mainRoot, `${sessionId}.jsonl`);
      try {
        if (deferInitialTranscriptWriter) {
          await result.current.replaceMessages([], sessionId, {
            restoreExistingSession: true,
            setConfigSessionId: true,
            transcriptProjectRoot: mainRoot,
            sessionPath: filePath,
          });
        } else {
          await result.current.replaceMessages([], sessionId);
        }
        await waitFor(() => {
          expect(onLocalSessionTitle).toHaveBeenCalledWith('Named session');
        });
        // Empty sessions intentionally buffer metadata until a message exists.
        await result.current.recordMessage({
          type: 'user',
          uuid: 'first-prompt',
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'hello' },
        });
        await result.current.dispose();
        const restored =
          await new TranscriptRepository().loadSessionWriterState(
            filePath,
            sessionId,
          );
        expect(restored.customTitle).toBe('Named session');
        expect(config.topicState.setTopic).toHaveBeenCalledWith(
          'Named session',
          undefined,
        );
      } finally {
        await result.current.dispose();
        unmount();
        await store.close();
      }
    },
  );

  it('rejects local rewind without a current transcript writer', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await expect(
      result.current.rewindConversation('user-b', {
        getExternalRevision: () => 0,
        assertReady: () => undefined,
        commitView: vi.fn(),
        restoreView: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'not-ready' });
    expect(result.current.getMessages()).toEqual([]);
  });

  it('does not persist supplementary history items marked as display-only', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    writer.recordMessages?.mockClear();

    await result.current.recordSupplementaryHistoryItem({
      type: 'info',
      text: 'startup command conflict',
      omitFromTranscript: true,
    });

    expect(writer.recordMessages).not.toHaveBeenCalled();
  });

  it('persists command caveat and wrapper as one writer-owned batch', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    writer.recordMessages?.mockClear();

    await result.current.recordSupplementaryHistoryItem({
      type: 'user',
      text: '/model',
    });

    expect(writer.recordMessages).toHaveBeenCalledTimes(1);
    const batch = writer.recordMessages?.mock.calls[0]?.[0] as Message[];
    expect(batch).toHaveLength(2);
    expect(batch.map((message) => message.type)).toEqual(['user', 'user']);
    const commandMessage = batch[1];
    if (commandMessage?.type !== 'user') {
      throw new Error('Expected the command wrapper to be a user message.');
    }
    expect(JSON.stringify(commandMessage.message.content)).toContain(
      '<command-name>/model</command-name>',
    );
    expect(result.current.getMessages()).toEqual(batch);
  });

  it('does not persist a null-content user message for a bare slash input', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    writer.recordMessages?.mockClear();

    // A bare "/" (completion popup dismissed) has no command name, so
    // there is no command metadata to wrap: nothing may be persisted.
    await result.current.recordSupplementaryHistoryItem({
      type: 'user',
      text: '/',
    });

    expect(writer.recordMessages).not.toHaveBeenCalled();
    expect(result.current.getMessages()).toEqual([]);
  });

  it('persists the local rewind marker before committing the view', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    const messages = rewindMessages();
    await result.current.replaceMessages(messages, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    const marker = deferred<void>();
    writer.recordActiveLeaf.mockImplementationOnce(() => marker.promise);
    const commitView = vi.fn();

    const pending = result.current.rewindConversation('user-b', {
      getExternalRevision: () => 0,
      assertReady: () => undefined,
      commitView,
      restoreView: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(writer.recordActiveLeaf).toHaveBeenCalledTimes(1),
    );
    expect(commitView).not.toHaveBeenCalled();
    expect(result.current.getMessages()).toEqual(messages);

    marker.resolve();
    await pending;
    expect(commitView).toHaveBeenCalledTimes(1);
    expect(result.current.getMessages().map((message) => message.uuid)).toEqual(
      ['user-a', 'assistant-a'],
    );
  });

  it('saves queued history in order before the next message after storage recovers', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    const originalWriterCount = coreMocks.transcriptWriterInstances.length;
    const first = rewindMessages()[0];
    const next = rewindMessages()[2];
    const failure = Object.assign(
      new Error('ENOSPC: no space left on device, write'),
      { code: 'ENOSPC' },
    );
    writer.recordMessages!.mockRejectedValueOnce(failure);
    await result.current.recordMessage(first);
    await result.current.recordMessage(next);
    expect(
      writer.recordMessages!.mock.calls.map((call) =>
        call[0].map((message: Message) => message.uuid),
      ),
    ).toEqual([[first.uuid], [first.uuid, next.uuid]]);
    expect(writer.recordMessages).toHaveBeenLastCalledWith([first, next]);
    expect(coreMocks.transcriptWriterInstances).toHaveLength(
      originalWriterCount,
    );
  });

  it('preserves the worktree, selected transcript and file rewind checkpoints across permission recovery', async () => {
    const { mainRoot, oldWorktreeRoot } = createDirs();
    const worktreeSettings = createWorktreeSettings(oldWorktreeRoot, mainRoot);
    const { config, workspaceContext } = createConfig({
      directories: [oldWorktreeRoot, mainRoot],
      targetDir: oldWorktreeRoot,
      worktreeSettings,
    });
    const sessionId = config.getSessionId();
    const filePath = nodePath.join(oldWorktreeRoot, 'legacy-session.jsonl');
    let deny = false;
    const failure = Object.assign(
      new Error(`EACCES: permission denied, open '${filePath}'`),
      { code: 'EACCES', syscall: 'open', path: filePath },
    );
    const store = new TranscriptStore({
      coordinatorOptions: {
        flushIntervalMs: 0,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          realpath,
          open: async (target, flags, mode) => {
            if (deny) throw failure;
            return nodeTranscriptFileSystem.open(target, flags, mode);
          },
        },
      },
    });
    vi.mocked(config.getTranscriptStore).mockReturnValue(store);
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const messages = [rewindMessages()[0], rewindMessages()[2]];
    const initialWriter = await store.acquireSessionWriter({
      filePath,
      sessionId,
      cwd: oldWorktreeRoot,
      entrypoint: 'cli',
    });
    await initialWriter.recordMessages(messages);
    await initialWriter.close();
    const { result, addItem } = await renderOrchestrator(config);
    try {
      await result.current.replaceMessages(messages, sessionId, {
        restoreExistingSession: false,
        sessionPath: filePath,
      });
      const snapshot = {
        messageId: messages[0].uuid,
        timestamp: new Date('2026-10-27T00:00:00.000Z'),
        cwd: oldWorktreeRoot,
        trackedFileBackups: {},
      };
      config.getFileHistoryManager()!.restoreStateFromSnapshots([snapshot]);
      const directories = [...workspaceContext.getDirectories()];
      const blocked = { ...messages[0], uuid: 'blocked' };
      const next = { ...messages[0], uuid: 'next' };
      deny = true;
      await result.current.recordMessage(blocked);
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining(filePath),
        }),
        expect.any(Number),
        true,
      );
      deny = false;
      await result.current.recordMessage(next);

      expect(config.getWorkingDir()).toBe(oldWorktreeRoot);
      expect(config.getTargetDir()).toBe(oldWorktreeRoot);
      expect(config.getWorktreeSettings()).toEqual(worktreeSettings);
      expect(workspaceContext.getDirectories()).toEqual(directories);
      expect(
        config.getFileHistoryManager()!.canRewind(snapshot.messageId),
      ).toBe(true);
      const restored = await store
        .repository()
        .resolveSession(filePath, { sessionId });
      expect(
        restored!.chain.map((message) => [message.uuid, message.parentUuid]),
      ).toEqual([
        [messages[0].uuid, null],
        [messages[1].uuid, messages[0].uuid],
        [blocked.uuid, messages[1].uuid],
        [next.uuid, blocked.uuid],
      ]);
    } finally {
      deny = false;
      await result.current.dispose().catch(() => undefined);
      await store.close().catch(() => undefined);
    }
  });

  it('reports the transcript path and retry guidance without querying while writes remain blocked', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, { addItem });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    const failure = Object.assign(
      new Error(`EACCES: permission denied, open '${writer.args.filePath}'`),
      { code: 'EACCES', syscall: 'open', path: writer.args.filePath },
    );
    writer.recordMessages!.mockRejectedValue(failure);
    vi.mocked(isChainParticipant).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [
        {
          type: 'user',
          uuid: 'input-1',
          timestamp: '2026-10-27T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      shouldQuery: true,
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('hello', { useInputProcessor: true });
    await result.current.submitQuery('retry', { useInputProcessor: true });

    expect(query).not.toHaveBeenCalled();
    const transcriptError = addItem.mock.calls
      .map(([item]) => item as { type?: string; text?: string })
      .find(
        (item) =>
          item.type === MessageType.ERROR &&
          item.text?.includes(writer.args.filePath),
      );
    expect(transcriptError?.text).toContain(
      'Failed to save the session transcript',
    );
    expect(transcriptError?.text).toContain('permissions');
  });

  it('finishes a failed pre-query snapshot and accepts the next submission without restart', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const finishTurn = vi.fn();
    const onTurnComplete = vi.fn();
    const onCoreEvent = vi.fn();
    const { result, addItem } = await renderOrchestrator(config, {
      runtimeProjection: { ...NOOP_RUNTIME_PROJECTION, finishTurn },
      onTurnComplete,
      onCoreEvent,
    });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const snapshots = coreMocks.fileHistoryManagerInstances.at(-1)!;
    snapshots.makeSnapshot.mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC',
      }),
    );
    vi.mocked(query).mockClear();
    await expect(result.current.submitQuery('first')).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(finishTurn).toHaveBeenCalledOnce();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.ERROR }),
      expect.any(Number),
      true,
    );
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(onCoreEvent).not.toHaveBeenCalled();
    await result.current.submitQuery('after cleanup');
    expect(query).toHaveBeenCalledOnce();
    expect(finishTurn).toHaveBeenCalledTimes(2);
  });

  it('drains completed tool results and resumes without executing the tools again', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const finishTurn = vi.fn();
    const { result } = await renderOrchestrator(config, {
      runtimeProjection: { ...NOOP_RUNTIME_PROJECTION, finishTurn },
    });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    let full = true;
    writer.recordMessages!.mockImplementation(async (messages: Message[]) => {
      if (full && messages[0].uuid === 'finished-tool') {
        throw Object.assign(new Error('ENOSPC: write failed'), {
          code: 'ENOSPC',
        });
      }
      return messages.at(-1)?.uuid ?? null;
    });
    let executedTools = 0;
    const releaseQuery = vi.fn();
    vi.mocked(query).mockImplementation(async function* (options: {
      prompt: string;
    }) {
      try {
        if (options.prompt === 'first') {
          yield { ...rewindMessages()[0], uuid: 'first' };
          executedTools += 2;
          yield {
            type: 'user',
            uuid: 'finished-tool',
            timestamp: '2026-10-09T00:00:00.000Z',
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
              ],
            },
          } as Message;
          // A parallel tool already finished when persistence aborted the turn.
          yield {
            type: 'user',
            uuid: 'parallel-tool',
            timestamp: '2026-10-09T00:00:00.000Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-2',
                  content: 'done too',
                },
              ],
            },
          } as Message;
        } else {
          yield { ...rewindMessages()[0], uuid: 'next' };
        }
        return { reason: 'end_turn' };
      } finally {
        releaseQuery();
      }
    } as never);
    await result.current.submitQuery('first');
    expect(finishTurn).toHaveBeenCalledOnce();
    expect(releaseQuery).toHaveBeenCalledOnce();
    expect(executedTools).toBe(2);
    // Still full: the next submission stops before starting another query.
    await result.current.submitQuery('still full');
    expect(query).toHaveBeenCalledOnce();
    full = false;
    await result.current.submitQuery('continue');
    expect(query).toHaveBeenCalledTimes(2);
    expect(executedTools).toBe(2);
    expect(result.current.getMessages().map((message) => message.uuid)).toEqual(
      ['first', 'finished-tool', 'parallel-tool', 'next'],
    );
    expect(writer.recordMessages).toHaveBeenLastCalledWith([
      expect.objectContaining({ uuid: 'next' }),
    ]);
  });

  it('flushes pending transcript records before planning a local rewind', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const pendingMessage = {
      type: 'user',
      uuid: 'pending-user',
      timestamp: '2026-08-04T00:00:03.000Z',
      message: { role: 'user', content: 'pending' },
    } as Message;
    const writer = {
      adoptMainParentUuid: vi.fn(),
      close: vi.fn(async () => undefined),
      getSessionId: () => 'current-session',
      recordActiveLeaf: vi.fn(async () => undefined),
      recordAiTitle: vi.fn(async () => undefined),
      recordCustomTitle: vi.fn(async () => undefined),
      recordFileHistorySnapshot: vi.fn(async () => undefined),
      recordMessages: vi.fn(
        async (messages: Message[]) => messages.at(-1)?.uuid ?? null,
      ),
      recordRuntimeConfig: vi.fn(async () => undefined),
      recordTokenStats: vi.fn(async () => undefined),
      recordWorktreeState: vi.fn(async () => undefined),
    };
    const acquireSessionWriter = vi
      .fn()
      .mockRejectedValueOnce(new Error('writer unavailable'))
      .mockResolvedValue(writer);
    vi.mocked(config.getTranscriptStore).mockReturnValue({
      acquireSessionWriter,
    } as unknown as ReturnType<Config['getTranscriptStore']>);
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);

    await result.current.recordMessage(pendingMessage);
    const messages = rewindMessages();
    await result.current.replaceMessages(messages, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });

    await result.current.rewindConversation('user-b', {
      getExternalRevision: () => 0,
      assertReady: () => undefined,
      commitView: vi.fn(),
      restoreView: vi.fn(),
    });

    expect(writer.adoptMainParentUuid).toHaveBeenCalledWith('user-b');
    expect(writer.recordMessages).toHaveBeenCalledWith([pendingMessage]);
    expect(writer.recordMessages.mock.invocationCallOrder[0]).toBeLessThan(
      coreMocks.executeConversationRewind.mock.invocationCallOrder[0],
    );
  });

  it('leaves local messages and view unchanged when marker persistence fails', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    const messages = rewindMessages();
    await result.current.replaceMessages(messages, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    writer.recordActiveLeaf.mockRejectedValueOnce(new Error('disk failed'));
    const commitView = vi.fn();
    const restoreView = vi.fn();

    await expect(
      result.current.rewindConversation('user-b', {
        getExternalRevision: () => 0,
        assertReady: () => undefined,
        commitView,
        restoreView,
      }),
    ).rejects.toThrow('disk failed');
    expect(result.current.getMessages()).toEqual(messages);
    expect(commitView).not.toHaveBeenCalled();
    expect(restoreView).not.toHaveBeenCalled();
  });

  it('compensates the old leaf when the external revision changes', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    const messages = rewindMessages();
    await result.current.replaceMessages(messages, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    const marker = deferred<void>();
    writer.recordActiveLeaf
      .mockImplementationOnce(() => marker.promise)
      .mockResolvedValueOnce(undefined);
    let revision = 1;

    const pending = result.current.rewindConversation('user-b', {
      getExternalRevision: () => revision,
      assertReady: () => undefined,
      commitView: vi.fn(),
      restoreView: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(writer.recordActiveLeaf).toHaveBeenCalledTimes(1),
    );
    revision += 1;
    marker.resolve();

    await expect(pending).rejects.toMatchObject({
      code: 'state-changed',
    });
    expect(writer.recordActiveLeaf).toHaveBeenNthCalledWith(2, 'user-b', {
      explicit: true,
      rewound: false,
      durable: true,
    });
    expect(result.current.getMessages()).toEqual(messages);
  });

  it('uses the retained local leaf as the parent of the next recorded message', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    const messages = rewindMessages();
    await result.current.replaceMessages(messages, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1)!;
    await result.current.rewindConversation('user-b', {
      getExternalRevision: () => 0,
      assertReady: () => undefined,
      commitView: vi.fn(),
      restoreView: vi.fn(),
    });
    writer.recordMessages?.mockClear();
    const next = {
      type: 'user',
      uuid: 'user-c',
      timestamp: '2026-08-04T00:00:04.000Z',
      message: { role: 'user', content: 'C' },
    } as Message;

    await result.current.recordMessage(next);

    expect(writer.recordActiveLeaf).toHaveBeenCalledWith('assistant-a', {
      explicit: true,
      rewound: true,
      durable: true,
    });
    expect(writer.recordMessages).toHaveBeenCalledWith([next]);
  });

  it('hosts Remote Control artifact delivery in the root-only tool registry', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    const presenter = vi.fn(async () => []);

    expect(coreMocks.promptAssemblerContexts).toContain(config.getSessionId());
    expect(rootToolRegistryMocks.mainRegistryProviders).toEqual([
      expect.any(Function),
    ]);

    const { PresentFilesTool } = await import(
      '../../session/artifacts/presentFilesTool.js'
    );
    result.current.toolRegistry.unregisterTool(
      'mcp__qw-builtin__present_files',
    );
    result.current.toolRegistry.registerTool(new PresentFilesTool(presenter));

    expect(rootToolRegistryMocks.unregisterTool).toHaveBeenCalledWith(
      'mcp__qw-builtin__present_files',
    );
    expect(rootToolRegistryMocks.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcp__qw-builtin__present_files',
        present: presenter,
      }),
    );

    result.current.toolRegistry.unregisterTool(
      'mcp__qw-builtin__present_files',
    );
    expect(rootToolRegistryMocks.unregisterTool).toHaveBeenLastCalledWith(
      'mcp__qw-builtin__present_files',
    );
  });

  it('sets the config session id before rebuilding resumed messages', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);
    const setSessionIdMock = vi.mocked(config.setSessionId);
    const schedulerContext = config;

    await replaceMessages(result, 'target-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(setSessionIdMock).toHaveBeenCalledWith('target-session');
    expect(config.getSessionId()).toBe('target-session');
    expect(schedulerContext.getSessionId()).toBe('target-session');
    expect(coreMocks.sessionStateStoreInstances.at(-1)?.args.sessionId).toBe(
      'target-session',
    );
    expect(setSessionIdMock.mock.invocationCallOrder[0]).toBeLessThan(
      coreMocks.sessionStateStoreInstances.at(-1)!.setWorkspaceDirectories.mock
        .invocationCallOrder[0],
    );

    unmount();
  });

  it('restores credits before starting resumed-session title generation', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    let resolveCreditsBinding:
      | ((dispose: () => Promise<void>) => void)
      | undefined;
    coreMocks.bindSessionUsagePersistence.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreditsBinding = resolve;
        }),
    );
    vi.mocked(isChainParticipant).mockReturnValue(true);
    const { result } = await renderOrchestrator(config);
    const resumedMessage = {
      type: 'user',
      uuid: 'resumed-user-message',
      message: { content: [{ type: 'text', text: 'resume this work' }] },
    } as Message;

    const resume = result.current.replaceMessages(
      [resumedMessage],
      'resumed-session',
      {
        restoreExistingSession: true,
        setConfigSessionId: true,
        transcriptProjectRoot: dirs.mainRoot,
      },
    );
    await vi.waitFor(() => {
      expect(coreMocks.bindSessionUsagePersistence).toHaveBeenCalled();
    });
    expect(generateSessionTitleForCurrentSession).not.toHaveBeenCalled();

    resolveCreditsBinding?.(async () => undefined);
    await resume;
    await new Promise((resolve) => setImmediate(resolve));

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(1);
    expect(
      coreMocks.bindSessionUsagePersistence.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(generateSessionTitleForCurrentSession).mock
        .invocationCallOrder[0],
    );
  });

  it('caps the settle wait when an interactive path disposes the previous credits binding', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    // The 30s default belongs to shutdown only; a rewind / resume / history
    // reload must never stall the TUI on credits settlement (issue 0050).
    const disposePrevious = vi.fn(async () => undefined);
    coreMocks.bindSessionUsagePersistence.mockResolvedValueOnce(
      disposePrevious,
    );
    const { result } = await renderOrchestrator(config);

    const firstMessage = {
      type: 'user',
      uuid: 'first-user-message',
      message: { content: [{ type: 'text', text: 'first session' }] },
    } as Message;
    await result.current.replaceMessages([firstMessage], 'first-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });
    expect(disposePrevious).not.toHaveBeenCalled();

    const secondMessage = {
      type: 'user',
      uuid: 'second-user-message',
      message: { content: [{ type: 'text', text: 'second session' }] },
    } as Message;
    await result.current.replaceMessages([secondMessage], 'second-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(disposePrevious).toHaveBeenCalledExactlyOnceWith({
      settleTimeoutMs: 1_500,
    });
  });

  it('drains pending records through their owning writer before closing it', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
    });
    const previousWriter = coreMocks.transcriptWriterInstances.at(-1)!;
    const pendingMessage = {
      type: 'user',
      uuid: 'previous-session-pending-user',
      timestamp: '2026-09-11T00:00:00.000Z',
      message: { role: 'user', content: 'persist before navigating away' },
    } as Message;
    previousWriter.recordMessages?.mockRejectedValueOnce(
      new Error('transient append failure'),
    );

    await result.current.recordMessage(pendingMessage);
    expect(previousWriter.recordMessages).toHaveBeenCalledTimes(1);

    await result.current.replaceMessages([], 'next-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(previousWriter.recordMessages).toHaveBeenCalledTimes(2);
    expect(previousWriter.recordMessages).toHaveBeenLastCalledWith([
      pendingMessage,
    ]);
    expect(
      previousWriter.recordMessages?.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(previousWriter.close.mock.invocationCallOrder[0]!);
    const nextWriter = coreMocks.transcriptWriterInstances.at(-1)!;
    expect(nextWriter).not.toBe(previousWriter);
    expect(nextWriter.recordMessages).not.toHaveBeenCalledWith([
      pendingMessage,
    ]);
  });

  it('queues target-session records until the target writer is published', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
    });
    const previousWriter = coreMocks.transcriptWriterInstances.at(-1)!;
    previousWriter.recordMessages?.mockClear();

    const targetStore = config.getTranscriptStore();
    const acquireTargetWriter = vi.mocked(targetStore.acquireSessionWriter);
    const acquireTargetWriterImpl = acquireTargetWriter.getMockImplementation();
    if (!acquireTargetWriterImpl) {
      throw new Error('Expected a transcript writer acquisition mock.');
    }
    const writerGate = deferred<void>();
    acquireTargetWriter.mockImplementation(async (options) => {
      await writerGate.promise;
      return acquireTargetWriterImpl(options);
    });
    vi.mocked(config.getTranscriptStore).mockReturnValue(targetStore);

    const switching = result.current.replaceMessages([], 'target-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });
    await vi.waitFor(() => {
      expect(config.getSessionId()).toBe('target-session');
      expect(acquireTargetWriter).toHaveBeenCalledTimes(1);
    });

    const duringSwitch = {
      type: 'user',
      uuid: 'target-session-during-switch',
      timestamp: '2026-09-11T00:00:01.000Z',
      message: { role: 'user', content: 'record in the target session' },
    } as Message;
    const recording = result.current.recordMessage(duringSwitch);
    await new Promise((resolve) => setImmediate(resolve));
    expect(previousWriter.recordMessages).not.toHaveBeenCalled();

    writerGate.resolve();
    await Promise.all([switching, recording]);

    const targetWriter = coreMocks.transcriptWriterInstances.at(-1)!;
    expect(targetWriter).not.toBe(previousWriter);
    expect(targetWriter.recordMessages).toHaveBeenCalledWith([duringSwitch]);
    expect(previousWriter.recordMessages).not.toHaveBeenCalledWith([
      duringSwitch,
    ]);
  });

  it('aborts and flushes a prompt suggestion before switching sessions', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
    });
    const previousStore = coreMocks.sessionStateStoreInstances.at(-1);
    let suggestionSignal: AbortSignal | undefined;
    coreMocks.tryGeneratePromptSuggestion.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          suggestionSignal = signal;
          signal.addEventListener('abort', () => resolve(null), {
            once: true,
          });
        }),
    );
    coreMocks.flushSessionUsage.mockClear();

    await result.current.submitQuery('finish the code change');
    await vi.waitFor(() => {
      expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledTimes(1);
    });

    await result.current.replaceMessages([], 'next-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(suggestionSignal?.aborted).toBe(true);
    expect(coreMocks.flushSessionUsage).toHaveBeenCalledWith(previousStore);
  });

  it('resets cwd/config when resuming a non-worktree session from a worktree', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const worktreeSettings = createWorktreeSettings(
      dirs.oldWorktreeRoot,
      dirs.mainRoot,
    );
    const { config, workspaceContext } = createConfig({
      directories: [
        dirs.oldWorktreeRoot,
        dirs.oldWorktreeChild,
        dirs.oldWorktreeChildLink,
        dirs.mainRoot,
        dirs.extraRoot,
      ],
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'main-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(config.setTargetDir).toHaveBeenCalledWith(dirs.mainRoot);
    expect(config.setWorkingDir).toHaveBeenCalledWith(dirs.mainRoot);
    expect(config.setWorktreeSettings).toHaveBeenCalledWith(undefined);
    expect(realpathSync(process.cwd())).toBe(realpathSync(dirs.mainRoot));
    expect(workspaceContext.setDirectories).toHaveBeenCalledWith([
      dirs.mainRoot,
      dirs.extraRoot,
    ]);
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );
    expect(coreMocks.fileHistoryManagerInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );

    unmount();
  });

  it.each([false, true])(
    'rebinds FileChanged paths during ordinary resume and only notifies a committed switch (failure=%s)',
    async (failResume) => {
      const dirs = createDirs();
      process.chdir(dirs.oldWorktreeRoot);
      const { config } = createConfig({
        directories: [dirs.oldWorktreeRoot],
        targetDir: dirs.oldWorktreeRoot,
        worktreeSettings: createWorktreeSettings(
          dirs.oldWorktreeRoot,
          dirs.mainRoot,
        ),
      });
      const { result, unmount } = await renderOrchestrator(config);
      vi.spyOn(config, 'getHookSystem').mockReturnValue({
        updateFileWatcherCwd: fixtureFileWatcher.updateFileWatcherCwd,
      } as never);
      fixtureFileWatcher.initializeFileChangedWatcher(
        dirs.oldWorktreeRoot,
        {
          getHooksForEvent: () => [{ matcher: 'watched.txt' }],
        } as unknown as HookRegistry,
        {
          fireFileChangedEvent: vi.fn(async () => undefined),
        } as unknown as HookEventHandler,
      );
      const notifyCwdChanged = vi.spyOn(Shell, 'notifyCwdChanged');
      const resumeGate = deferred<void>();
      coreMocks.applyResumeWorktreeState.mockImplementationOnce(
        async (_config, _state, record) => {
          await resumeGate.promise;
          await record(null);
          if (failResume) throw new Error('resume failed');
          return {
            status: 'ordinary',
            worktreeSession: null,
            acceptLegacyFileHistorySnapshots: true,
          };
        },
      );
      const resume = replaceMessages(result, 'ordinary-session', {
        restoreExistingSession: true,
        transcriptProjectRoot: dirs.mainRoot,
        worktreeSession: null,
      });
      const completion = (async () => {
        if (failResume) {
          await expect(resume).rejects.toThrow('resume failed');
        } else {
          await resume;
        }
      })();
      try {
        await waitFor(() =>
          expect(coreMocks.applyResumeWorktreeState).toHaveBeenCalled(),
        );
        expect(watch).toHaveBeenLastCalledWith(
          [nodePath.join(dirs.mainRoot, 'watched.txt')],
          expect.anything(),
        );
        expect(notifyCwdChanged).not.toHaveBeenCalled();
      } finally {
        resumeGate.resolve();
        await completion;
        unmount();
      }
      const expectedCwd = failResume ? dirs.oldWorktreeRoot : dirs.mainRoot;
      expect(config.getWorkingDir()).toBe(expectedCwd);
      expect(watch).toHaveBeenLastCalledWith(
        [nodePath.join(expectedCwd, 'watched.txt')],
        expect.anything(),
      );
      if (failResume) {
        expect(notifyCwdChanged).not.toHaveBeenCalled();
      } else {
        expect(notifyCwdChanged).toHaveBeenCalledWith(
          dirs.oldWorktreeRoot,
          dirs.mainRoot,
          null,
        );
      }
      notifyCwdChanged.mockRestore();
    },
  );

  it.each([false, true])(
    'commits worktree resume only after FileHistory rehydration (failure=%s)',
    async (failResume) => {
      const dirs = createDirs();
      const oldCwd = realpathSync(dirs.oldWorktreeRoot);
      const nextCwd = realpathSync(dirs.targetWorktreeRoot);
      const originalCwd = realpathSync(dirs.mainRoot);
      process.chdir(oldCwd);
      const previousHistory = new RealFileHistoryManager({
        cwd: oldCwd,
        sessionId: 'current-session',
        enabled: true,
      });
      await previousHistory.makeSnapshot('previous-message');
      const previousSnapshots = previousHistory.getSnapshots();
      const { config, workspaceContext } = createConfig({
        directories: [oldCwd],
        targetDir: oldCwd,
        worktreeSettings: createWorktreeSettings(oldCwd, originalCwd),
        fileHistoryManager: previousHistory,
      });
      const { result } = await renderOrchestrator(config, {
        deferInitialTranscriptWriter: true,
      });
      coreMocks.applyResumeWorktreeState.mockImplementationOnce(
        async (config, state, recordWorktreeState) => {
          const outcome = await worktreeSessionService.restore(
            {
              config,
              sessionId: config.getSessionId(),
              phase: 'restore',
              recordWorktreeState,
            },
            state,
          );
          if (outcome.status !== 'restored') {
            throw new Error(JSON.stringify(outcome));
          }
          return {
            status: 'restored',
            worktreeSession: state,
            acceptLegacyFileHistorySnapshots: false,
          };
        },
      );
      const reachedRehydration = deferred<void>();
      const rehydrate = deferred<void>();
      coreMocks.rehydrateFileHistory.mockImplementationOnce(async () => {
        reachedRehydration.resolve();
        await rehydrate.promise;
        if (failResume) throw new Error('rehydration failed');
      });
      const notify = vi.spyOn(Shell, 'notifyCwdChanged');
      const resume = result.current.replaceMessages([], 'next-session', {
        restoreExistingSession: true,
        setConfigSessionId: true,
        transcriptProjectRoot: originalCwd,
        targetWorkspaceDirectories: [dirs.extraRoot],
        fileHistorySnapshots: [],
        worktreeSession: {
          sessionId: 'next-session',
          worktreeName: 'target',
          worktreePath: nextCwd,
          worktreeCwd: nextCwd,
          originalCwd,
          hookBased: true,
          lifecycle: 'attached',
        },
      });
      const completion = resume.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          reachedRehydration.promise,
          completion.then((error) => {
            if (error) throw error;
          }),
        ]);
        expect(config.getWorkingDir()).toBe(nextCwd);
        expect(notify).not.toHaveBeenCalled();
        rehydrate.resolve();
        const error = await completion;
        if (failResume) {
          expect(error).toEqual(new Error('rehydration failed'));
          expect(config.getWorkingDir()).toBe(oldCwd);
          expect(workspaceContext.getDirectories()).toEqual([oldCwd]);
          expect(config.getFileHistoryManager()).toBe(previousHistory);
          expect(previousHistory.getSnapshots()).toEqual(previousSnapshots);
          expect(notify).not.toHaveBeenCalled();
        } else {
          expect(error).toBeUndefined();
          expect(workspaceContext.getDirectories()).toContain(dirs.extraRoot);
          expect(notify).toHaveBeenCalledExactlyOnceWith(oldCwd, nextCwd, null);
        }
      } finally {
        rehydrate.resolve();
        await completion;
        notify.mockRestore();
      }
    },
  );

  it('anchors a new worktree session writer at originalCwd before recording runtime state', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const worktreeSettings = createWorktreeSettings(
      dirs.oldWorktreeRoot,
      dirs.mainRoot,
    );
    const { config } = createConfig({
      directories: [dirs.oldWorktreeRoot],
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: false,
    });

    const writer = coreMocks.transcriptWriterInstances.at(-1);
    expect(writer?.args.cwd).toBe(dirs.mainRoot);
    expect(writer?.args.filePath).toBe(
      nodePath.join(dirs.mainRoot, 'current-session.jsonl'),
    );
    expect(writer?.recordWorktreeState).toHaveBeenCalledWith(
      expect.objectContaining({
        originalCwd: dirs.mainRoot,
        worktreeCwd: dirs.oldWorktreeRoot,
      }),
    );
    unmount();
  });

  it('reports the retained legacy writer path through the runtime binding', async () => {
    const dirs = createDirs();
    const legacyTranscriptPath = nodePath.join(
      dirs.oldWorktreeRoot,
      'legacy-session.jsonl',
    );
    const { config } = createConfig({
      directories: [dirs.oldWorktreeRoot],
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings: createWorktreeSettings(
        dirs.oldWorktreeRoot,
        dirs.mainRoot,
      ),
    });
    vi.mocked(migrateLegacyWorktreeTranscript).mockResolvedValueOnce(undefined);
    const { result, unmount } = await renderHook(() =>
      useLocalTuiSessionOrchestrator({
        addItem: vi.fn(),
        config,
        focusMachine: null,
        getPreferredEditor: () => undefined,
        initialConversationHistory: undefined,
        onCancelSubmit: vi.fn(),
        runtimeProjectionRef: {
          current: NOOP_RUNTIME_PROJECTION,
        } as MutableRefObject<RuntimeProjectionController>,
        settings: {
          merged: {
            security: { auth: { selectedType: AuthType.QODER_BROWSER } },
            promptSuggestionEnabled: true,
          },
        } as unknown as LoadedSettings,
        version: 'test-version',
      }),
    );

    await result.current.replaceMessages([], 'legacy-session', {
      restoreExistingSession: true,
      sessionPath: legacyTranscriptPath,
      transcriptProjectRoot: dirs.mainRoot,
    });

    const binding = vi
      .mocked(config.registerSessionRuntimeBinding)
      .mock.calls.map(([value]) => value)
      .findLast((value) => value !== undefined);

    expect(binding?.getTranscriptPath?.()).toBe(legacyTranscriptPath);
    unmount();
  });

  it('resumes an exited legacy session in its original project without moving its writer', async () => {
    const dirs = createDirs();
    const legacyTranscriptPath = nodePath.join(
      dirs.oldWorktreeRoot,
      'legacy-session.jsonl',
    );
    const { config } = createConfig({
      directories: [dirs.oldWorktreeRoot],
      targetDir: dirs.oldWorktreeRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await result.current.replaceMessages([], 'legacy-session', {
      restoreExistingSession: true,
      sessionPath: legacyTranscriptPath,
      transcriptProjectRoot: dirs.oldWorktreeRoot,
      originalCwd: dirs.mainRoot,
      worktreeSession: null,
    });

    expect(config.getWorkingDir()).toBe(dirs.mainRoot);
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args).toMatchObject({
      filePath: legacyTranscriptPath,
      cwd: dirs.mainRoot,
    });
    unmount();
  });

  it('keeps target session workspace directories under the stale worktree root', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const { config, workspaceContext } = createConfig({
      directories: [
        dirs.oldWorktreeRoot,
        dirs.oldWorktreeChild,
        dirs.mainRoot,
        dirs.extraRoot,
      ],
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings: createWorktreeSettings(
        dirs.oldWorktreeRoot,
        dirs.mainRoot,
      ),
    });
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'main-session', {
      restoreExistingSession: true,
      targetWorkspaceDirectories: [dirs.oldWorktreeChild],
      transcriptProjectRoot: dirs.mainRoot,
    });

    expect(workspaceContext.setDirectories).toHaveBeenCalledWith([
      dirs.mainRoot,
      dirs.oldWorktreeChild,
      dirs.extraRoot,
    ]);
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );

    unmount();
  });

  it('uses the transcript worktree state as the resume input', async () => {
    const dirs = createDirs();
    process.chdir(dirs.mainRoot);
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.targetWorktreeRoot,
      worktreeSession: {
        originalCwd: dirs.mainRoot,
        preEnterOriginalCwd: dirs.mainRoot,
        sessionId: 'current-session',
        worktreeName: 'target-worktree',
        worktreePath: dirs.targetWorktreeRoot,
        worktreeBranch: 'feature/target',
        lifecycle: 'attached',
      },
    });

    expect(coreMocks.applyResumeWorktreeState).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        worktreePath: dirs.targetWorktreeRoot,
        lifecycle: 'attached',
      }),
      expect.any(Function),
    );
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );
    unmount();
  });

  it('rejects legacy FileHistory snapshots after missing-worktree fallback', async () => {
    const dirs = createDirs();
    const { config } = createConfig({
      directories: [dirs.mainRoot],
      targetDir: dirs.mainRoot,
    });
    coreMocks.applyResumeWorktreeState.mockImplementationOnce(
      async (_config, _state, record) => {
        await record(null);
        return {
          status: 'fallback',
          worktreeSession: null,
          acceptLegacyFileHistorySnapshots: false,
        };
      },
    );
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'missing-worktree-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
      worktreeSession: {
        originalCwd: dirs.mainRoot,
        preEnterOriginalCwd: dirs.mainRoot,
        sessionId: 'missing-worktree-session',
        worktreeName: 'missing-worktree',
        worktreePath: dirs.targetWorktreeRoot,
        lifecycle: 'owner',
      },
    });

    expect(
      coreMocks.fileHistoryManagerInstances.at(-1)?.args.acceptLegacySnapshots,
    ).toBe(false);
    unmount();
  });

  it('treats an explicit transcript worktree null as authoritative on resume', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const { config } = createConfig({
      directories: [dirs.oldWorktreeRoot, dirs.mainRoot],
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings: createWorktreeSettings(
        dirs.oldWorktreeRoot,
        dirs.mainRoot,
      ),
    });
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'main-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
      worktreeSession: null,
    });

    expect(config.setWorktreeSettings).toHaveBeenCalledWith(undefined);
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );
    unmount();
  });

  it.each([
    ['without explicit transcript root', undefined],
    ['when explicit root is the current worktree root', 'root'],
    ['when explicit root is inside the current worktree', 'child'],
  ])(
    'uses the explicit ordinary-session root for null state %s',
    async (_, root) => {
      const dirs = createDirs();
      process.chdir(dirs.oldWorktreeRoot);
      const explicitRoot =
        root === 'root'
          ? dirs.oldWorktreeRoot
          : root === 'child'
            ? dirs.oldWorktreeChild
            : undefined;
      const { config } = createConfig({
        directories: [
          dirs.oldWorktreeRoot,
          dirs.oldWorktreeChild,
          dirs.mainRoot,
        ],
        targetDir: dirs.oldWorktreeRoot,
        worktreeSettings: createWorktreeSettings(
          dirs.oldWorktreeRoot,
          dirs.mainRoot,
        ),
      });
      const { result, unmount } = await renderOrchestrator(config);

      await replaceMessages(result, 'current-worktree-session', {
        restoreExistingSession: true,
        ...(explicitRoot ? { transcriptProjectRoot: explicitRoot } : {}),
      });

      if (explicitRoot) {
        expect(config.setWorktreeSettings).toHaveBeenCalledWith(undefined);
        expect(config.setTargetDir).toHaveBeenCalledWith(explicitRoot);
        expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
          explicitRoot,
        );
      } else {
        expect(config.setWorktreeSettings).toHaveBeenCalledWith(undefined);
        expect(config.setTargetDir).toHaveBeenCalledWith(dirs.mainRoot);
        expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
          dirs.mainRoot,
        );
      }

      unmount();
    },
  );

  it('preserves the current project when a resumed transcript worktree has been removed', async () => {
    const dirs = createDirs();
    const missingWorktreeRoot = nodePath.join(
      dirs.mainRoot,
      '.qwen',
      'worktrees',
      'removed',
    );
    process.chdir(dirs.mainRoot);
    const { config } = createConfig({
      directories: [dirs.mainRoot, dirs.extraRoot],
      targetDir: dirs.mainRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await replaceMessages(result, 'removed-worktree-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: missingWorktreeRoot,
    });

    expect(config.setTargetDir).not.toHaveBeenCalledWith(missingWorktreeRoot);
    expect(config.setWorkingDir).not.toHaveBeenCalledWith(missingWorktreeRoot);
    expect(realpathSync(process.cwd())).toBe(realpathSync(dirs.mainRoot));
    expect(coreMocks.sessionStateStoreInstances.at(-1)?.args.projectRoot).toBe(
      missingWorktreeRoot,
    );
    expect(coreMocks.transcriptWriterInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );
    expect(coreMocks.fileHistoryManagerInstances.at(-1)?.args.cwd).toBe(
      dirs.mainRoot,
    );

    unmount();
  });

  it('rolls back previous cwd/config when explicit root reset fails', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const worktreeSettings = createWorktreeSettings(
      dirs.oldWorktreeRoot,
      dirs.mainRoot,
    );
    const { config, workspaceContext } = createConfig({
      directories: [dirs.oldWorktreeRoot, dirs.mainRoot],
      failSetDirectoriesOnce: true,
      targetDir: dirs.oldWorktreeRoot,
      worktreeSettings,
    });
    const { result, unmount } = await renderOrchestrator(config);
    const replaceOptions = {
      restoreExistingSession: true,
      transcriptProjectRoot: dirs.mainRoot,
    };

    await expect(
      result.current.replaceMessages(
        [] as Message[],
        'main-session',
        replaceOptions,
      ),
    ).rejects.toThrow('setDirectories failed');

    expect(config.setTargetDir).toHaveBeenLastCalledWith(dirs.oldWorktreeRoot);
    expect(config.setWorkingDir).toHaveBeenLastCalledWith(dirs.oldWorktreeRoot);
    expect(config.setWorktreeSettings).toHaveBeenLastCalledWith(
      worktreeSettings,
    );
    expect(workspaceContext.setDirectories).toHaveBeenLastCalledWith([
      dirs.oldWorktreeRoot,
      dirs.mainRoot,
    ]);
    expect(realpathSync(process.cwd())).toBe(
      realpathSync(dirs.oldWorktreeRoot),
    );
    expect(coreMocks.transcriptWriterInstances).toHaveLength(0);
    expect(coreMocks.fileHistoryManagerInstances).toHaveLength(0);

    unmount();
  });

  it('keeps the previous session identity, messages and writer when resume fails', async () => {
    const dirs = createDirs();
    process.chdir(dirs.oldWorktreeRoot);
    const { config, workspaceContext } = createConfig({
      directories: [dirs.oldWorktreeRoot, dirs.mainRoot],
      targetDir: dirs.oldWorktreeRoot,
    });
    const { result, unmount } = await renderOrchestrator(config);
    const previousMessage = {
      type: 'user',
      uuid: 'previous-message',
      message: { role: 'user', content: 'previous conversation' },
    } as Message;
    await result.current.replaceMessages([previousMessage], 'current-session', {
      restoreExistingSession: true,
    });
    const previousWriter = coreMocks.transcriptWriterInstances.at(-1)!;
    workspaceContext.setDirectories.mockImplementationOnce(() => {
      throw new Error('setDirectories failed');
    });

    await expect(
      result.current.replaceMessages([], 'failed-session', {
        restoreExistingSession: true,
        setConfigSessionId: true,
        transcriptProjectRoot: dirs.mainRoot,
      }),
    ).rejects.toThrow('setDirectories failed');

    expect(config.getSessionId()).toBe('current-session');
    expect(result.current.getMessages()).toEqual([previousMessage]);
    expect(previousWriter.close).not.toHaveBeenCalled();
    expect(coreMocks.transcriptWriterInstances).toHaveLength(1);

    unmount();
  });

  it('executes a local slash command while workspace state persistence is pending', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let resolveStateWrite: (() => void) | undefined;
    coreMocks.setWorkspaceDirectoriesImpl.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStateWrite = resolve;
      }),
    );
    const { result } = await renderOrchestrator(config);

    let rebuildSettled = false;
    const rebuildPromise = result.current
      .replaceMessages([], config.getSessionId(), {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      })
      .then(() => {
        rebuildSettled = true;
      });
    await vi.waitFor(() => {
      expect(coreMocks.setWorkspaceDirectoriesImpl).toHaveBeenCalled();
      expect(rebuildSettled).toBe(true);
    });
    await rebuildPromise;

    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(executeUserInput).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        attachmentCtx: expect.objectContaining({
          agentId: config.getSessionId(),
          cwd: mainRoot,
        }),
      }),
    );
    expect(query).not.toHaveBeenCalled();

    resolveStateWrite?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('dispatches a local slash command before transcript rebuild has run', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(coreMocks.transcriptWriterInstances).toHaveLength(0);
    expect(executeUserInput).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        attachmentCtx: expect.objectContaining({
          agentId: config.getSessionId(),
          cwd: mainRoot,
        }),
      }),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('dispatches a local slash command while the tool registry is still initializing', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    // Reproduces feedback "启动后立刻 /resume 就卡死": during slow startups the
    // tool registry only exists after Config base initialization, while the
    // TUI input is already usable. Building the turn prompt resolver on a
    // slash submission then dereferenced an undefined registry.
    (
      config.isInitialized as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValue(false);
    vi.mocked(createTurnPromptResolver).mockImplementation(async () =>
      // Mirror core's render-inputs crash when the registry is undefined.
      Promise.reject(
        new TypeError(
          "undefined is not an object (evaluating 'agentLoopContext.toolRegistry.getAllToolNames')",
        ),
      ),
    );
    try {
      const startTurn = vi.fn();
      const finishTurn = vi.fn();
      const { result } = await renderOrchestrator(config, {
        runtimeProjection: {
          ...NOOP_RUNTIME_PROJECTION,
          startTurn,
          finishTurn,
        },
      });
      vi.mocked(executeUserInput).mockResolvedValueOnce({
        messages: [],
        shouldQuery: false,
      });
      vi.mocked(query).mockClear();
      vi.mocked(createTurnPromptResolver).mockClear();

      await expect(
        result.current.submitQuery('/model', {
          useInputProcessor: true,
        }),
      ).resolves.toBeUndefined();

      // Slash-only submissions never need the system prompt: no resolver is
      // built, the command is dispatched, and the turn is not left busy.
      expect(createTurnPromptResolver).not.toHaveBeenCalled();
      expect(executeUserInput).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ cwd: mainRoot }),
      );
      expect(query).not.toHaveBeenCalled();
      expect(finishTurn).toHaveBeenCalled();
    } finally {
      vi.mocked(createTurnPromptResolver).mockRestore();
    }
  });

  it('waits for base initialization before building the deferred turn prompt resolver', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let initialized = false;
    let releaseBaseGate: (() => void) | undefined;
    const waitForStartupGate = vi.fn(
      (_gate: string) =>
        new Promise<void>((resolve) => {
          releaseBaseGate = () => resolve();
        }),
    );
    Object.assign(config, {
      isInitialized: vi.fn(() => initialized),
      waitForStartupGate,
    });
    const resolveSystemPromptInner: TurnPromptResolver = vi.fn(
      async () =>
        ({
          blocks: [],
          source: 'default',
          bundle: 'full',
        }) as unknown as PromptBuildResult,
    );
    const createResolver = vi.fn(async () => resolveSystemPromptInner);

    const resolver = createTurnPromptResolverAfterRegistryReady(
      config,
      createResolver,
    );

    // Not initialized: the factory must not build anything yet.
    expect(createResolver).not.toHaveBeenCalled();

    let resolved: Awaited<ReturnType<typeof resolver>> | undefined;
    const resolverPromise = resolver().then((value) => {
      resolved = value;
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Still waiting on the 'base' gate (which Config marks ready only after
    // the tool registry is assigned) — no resolver built, promise pending.
    expect(waitForStartupGate).toHaveBeenCalledTimes(1);
    expect(waitForStartupGate.mock.calls[0]?.[0]).toBe('base');
    expect(createResolver).not.toHaveBeenCalled();
    expect(resolved).toBeUndefined();

    initialized = true;
    releaseBaseGate?.();
    await resolverPromise;

    expect(createResolver).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(resolveSystemPromptInner);

    // The built resolver is reused for later requests within this turn.
    await resolver();
    expect(createResolver).toHaveBeenCalledTimes(1);
  });

  it('defers the turn prompt resolver until after request readiness even with initialized config', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const resolveSystemPromptInner: TurnPromptResolver = vi.fn(
      async () =>
        ({
          blocks: [],
          source: 'default',
          bundle: 'full',
        }) as unknown as PromptBuildResult,
    );
    const createResolver = vi.fn(async () => resolveSystemPromptInner);

    const resolver = createTurnPromptResolverAfterRegistryReady(
      config,
      createResolver,
    );

    // Base readiness alone is insufficient: policy may still be loading.
    expect(createResolver).not.toHaveBeenCalled();
    expect(config.waitForStartupGate).not.toHaveBeenCalled();
    await expect(resolver()).resolves.toBe(resolveSystemPromptInner);
    expect(createResolver).toHaveBeenCalledTimes(1);
  });

  it('waits for remote configuration before processing input and capturing the first turn policy', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let releaseConfig!: () => void;
    vi.mocked(ensureConfigReadyForRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseConfig = () =>
            resolve({ status: 'ready', source: 'remote', revision: 'test:1' });
        }),
    );
    const { result } = await renderOrchestrator(config);
    vi.mocked(createTurnPromptResolver).mockClear();
    vi.mocked(executeUserInput).mockClear();
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: true,
    });
    vi.mocked(query).mockClear();

    const pending = result.current.submitQuery('hello', {
      useInputProcessor: true,
    });
    await vi.waitFor(() => expect(releaseConfig).toBeTypeOf('function'));
    expect(executeUserInput).not.toHaveBeenCalled();
    expect(createTurnPromptResolver).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();

    releaseConfig();
    await pending;
    expect(executeUserInput).toHaveBeenCalledTimes(1);
    expect(createTurnPromptResolver).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('preserves pending hook output when cwd changes within one session', async () => {
    const { mainRoot, oldWorktreeRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    result.current.queueHookContext('before worktree restore');
    config.setWorkingDir(oldWorktreeRoot);
    result.current.queueHookContext('after worktree restore');

    const contexts = vi
      .mocked(createAttachmentContext)
      .mock.results.map(({ value }) => value as AttachmentToolUseContext);
    const previousContext = contexts.at(-2);
    const reboundContext = contexts.at(-1);

    expect(previousContext?.pendingHookOutputs).toEqual([]);
    expect(
      reboundContext?.pendingHookOutputs.map(({ output }) => output),
    ).toEqual(['before worktree restore', 'after worktree restore']);
  });

  it('restores attachment state and skips duplicate SessionStart context', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const history = [
      {
        type: 'attachment',
        uuid: 'skills',
        timestamp: '2026-08-19T00:00:00.000Z',
        attachment: {
          type: 'skill_listing',
          content: '- inspect: Inspect a repository',
          names: ['inspect'],
          skillCount: 1,
          isInitial: true,
        },
      },
      {
        type: 'attachment',
        uuid: 'session-hook',
        timestamp: '2026-08-19T00:00:01.000Z',
        attachment: {
          type: 'hook_output',
          hookEventName: 'SessionStart',
          output: 'workspace ready',
        },
      },
    ] as Message[];
    const { result } = await renderOrchestrator(config, {
      initialConversationHistory: history,
    });

    result.current.queueHookContext(
      'workspace ready',
      HookEventName.SessionStart,
      'additionalContext',
    );
    result.current.queueHookContext(
      'new startup context',
      HookEventName.SessionStart,
      'additionalContext',
    );

    const attachmentCtx = vi.mocked(createAttachmentContext).mock.results.at(-1)
      ?.value as AttachmentToolUseContext;
    expect([
      ...attachmentCtx.sentSkillNames.get(config.getSessionId())!,
    ]).toEqual(['inspect']);
    expect(attachmentCtx.pendingHookOutputs).toEqual([
      expect.objectContaining({ output: 'new startup context' }),
    ]);
  });

  it('restores invoked Skill bodies during session resume', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const history = [
      {
        type: 'attachment',
        uuid: 'invoked-skills',
        timestamp: '2026-08-19T00:00:02.000Z',
        attachment: {
          type: 'invoked_skills',
          skills: [
            {
              name: 'inspect',
              path: '/skills/inspect/SKILL.md',
              content: 'Rendered inspect body',
            },
          ],
        },
      },
    ] as Message[];
    const { result } = await renderOrchestrator(config);

    await result.current.replaceMessages(history, 'resumed-session', {
      restoreExistingSession: true,
      setConfigSessionId: true,
      transcriptProjectRoot: mainRoot,
    });

    expect(coreMocks.restoreInvokedSkillsFromTranscript).toHaveBeenCalledWith(
      expect.any(Object),
      history,
    );
  });

  it('drops queued SessionStart context already present in replacement history', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    const history = [
      {
        type: 'attachment',
        uuid: 'session-hook',
        timestamp: '2026-08-19T00:00:01.000Z',
        attachment: {
          type: 'hook_output',
          hookEventName: 'SessionStart',
          output: 'workspace ready',
        },
      },
    ] as Message[];

    result.current.queueHookContext(
      'workspace ready',
      HookEventName.SessionStart,
      'additionalContext',
    );
    await result.current.replaceMessages(history, config.getSessionId(), {
      restoreExistingSession: true,
    });

    const attachmentCtx = vi.mocked(createAttachmentContext).mock.results.at(-1)
      ?.value as AttachmentToolUseContext;
    expect(attachmentCtx.pendingHookOutputs).toEqual([]);
  });

  it('does not carry pending hook output into a new session', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    result.current.queueHookContext('old session output');
    config.setSessionId('next-session');
    result.current.queueHookContext('new session output');

    const contexts = vi
      .mocked(createAttachmentContext)
      .mock.results.map(({ value }) => value as AttachmentToolUseContext);
    const previousContext = contexts.at(-2);
    const nextSessionContext = contexts.at(-1);

    expect(
      previousContext?.pendingHookOutputs.map(({ output }) => output),
    ).toEqual(['old session output']);
    expect(
      nextSessionContext?.pendingHookOutputs.map(({ output }) => output),
    ).toEqual(['new session output']);
  });

  it('keeps local slash dispatch available after workspace state persistence fails', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    coreMocks.setWorkspaceDirectoriesImpl.mockRejectedValueOnce(
      Object.assign(new Error('rename failed'), { code: 'EPERM' }),
    );
    const { result } = await renderOrchestrator(config);

    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    await new Promise((resolve) => setImmediate(resolve));

    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(executeUserInput).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('keeps ordinary resume usable after the resolver selects null state', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await expect(
      result.current.replaceMessages([], config.getSessionId(), {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      }),
    ).resolves.toBeUndefined();
    expect(coreMocks.transcriptWriterInstances).toHaveLength(1);
    expect(coreMocks.setWorkspaceDirectoriesImpl).toHaveBeenCalled();

    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(executeUserInput).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not downgrade processor failures to the raw input path', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const addItem = vi.fn();
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config, { addItem });
    vi.mocked(executeUserInput).mockRejectedValueOnce(
      new Error('processor failed'),
    );
    vi.mocked(getAttachmentMessages).mockClear();
    vi.mocked(processPastedImages).mockClear();
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model [Image #1]', {
      pastedContents: {
        1: {
          type: 'image',
          content: 'not-used',
          id: 1,
        },
      },
      useInputProcessor: true,
    });

    expect(query).not.toHaveBeenCalled();
    expect(getAttachmentMessages).not.toHaveBeenCalled();
    expect(processPastedImages).not.toHaveBeenCalled();
    expect(
      addItem.mock.calls.some(
        ([item]) =>
          item.type === MessageType.USER && item.text === '/model [Image #1]',
      ),
    ).toBe(false);
    expect(addItem).toHaveBeenCalledWith({
      type: MessageType.ERROR,
      text: 'Error: processor failed',
    });
  });

  it('restores the prompt when input processing rejects a pasted image', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onCancelSubmit = vi.fn();
    const { result } = await renderOrchestrator(config, { onCancelSubmit });
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
      resultIsError: true,
      resultText: 'Unable to attach image',
    });
    vi.mocked(query).mockClear();

    await result.current.submitQuery('inspect [Image #0]', {
      pastedContents: {
        0: {
          type: 'image',
          content: 'not-used',
          id: 0,
        },
      },
      useInputProcessor: true,
    });

    expect(query).not.toHaveBeenCalled();
    expect(onCancelSubmit).toHaveBeenCalledWith(true);
  });

  it.each([
    { stage: 'input processing', shouldQuery: true },
    { stage: 'input processing', shouldQuery: false },
    { stage: 'model preparation', shouldQuery: true },
  ])(
    'discards cancelled input after $stage (shouldQuery=$shouldQuery)',
    async ({ stage, shouldQuery }) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      Object.assign(config, {
        getGoalManager: () => ({ isGoalActive: false }),
      });
      const onLocalUserMessage = vi.fn();
      const handleInputResolved = vi.fn();
      const { result } = await renderOrchestrator(config, {
        onLocalUserMessage,
        runtimeProjection: {
          ...NOOP_RUNTIME_PROJECTION,
          handleInputResolved,
        },
      });
      const entered = deferred<void>();
      const processed =
        deferred<Awaited<ReturnType<typeof executeUserInput>>>();
      vi.mocked(executeUserInput).mockImplementationOnce(async () => {
        entered.resolve();
        return processed.promise;
      });
      const preparing = deferred<void>();
      const prepared = deferred<void>();
      if (stage === 'model preparation') {
        vi.mocked(applyMcpLazyLoad)
          .mockResolvedValueOnce({ status: 'not-attempted-no-tools' })
          .mockImplementationOnce(async () => {
            preparing.resolve();
            await prepared.promise;
            return { status: 'not-attempted-no-tools' };
          });
      }
      vi.mocked(query).mockClear();

      const submission = result.current.submitQuery('cancelled prompt', {
        useInputProcessor: true,
      });
      await entered.promise;
      if (stage === 'input processing') {
        result.current.cancelOngoingRequest();
      }
      processed.resolve({
        messages: [
          {
            type: 'user',
            uuid: 'cancelled-processed-user',
            message: { role: 'user', content: 'cancelled prompt' },
          } as Message,
        ],
        shouldQuery,
      });
      if (stage === 'model preparation') {
        await preparing.promise;
        result.current.cancelOngoingRequest();
        prepared.resolve();
      }
      handleInputResolved.mockClear();
      await submission;

      expect(onLocalUserMessage).not.toHaveBeenCalled();
      expect(handleInputResolved).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('silently stops an aborted processor without entering the raw input path', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const addItem = vi.fn();
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config, { addItem });
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    vi.mocked(executeUserInput).mockRejectedValueOnce(abortError);
    vi.mocked(getAttachmentMessages).mockClear();
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(query).not.toHaveBeenCalled();
    expect(getAttachmentMessages).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
  });

  it('echoes command-style input that falls back to a plain text prompt', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const promptText = '/Users/demo/dashboard 分析这个项目';
    const addItem = vi.fn();
    const onSlashCommand = vi.fn(async () => false as const);
    const { result } = await renderOrchestrator(config, {
      addItem,
      onSlashCommand,
    });
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        // Mirror processor.ts: unknown slash-style input asks the slash
        // handler first; a `false` result falls back to a plain text prompt.
        const slashResult = await context.onSlashCommand?.(
          promptText,
          [],
          [],
          [],
        );
        expect(slashResult).toBe(false);
        return {
          messages: [
            {
              type: 'user',
              uuid: 'processed-user-message',
              message: { role: 'user', content: promptText },
              origin: { kind: 'human' },
            } as Message,
          ],
          shouldQuery: true,
        };
      },
    );
    vi.mocked(query).mockClear();

    await result.current.submitQuery(promptText, {
      useInputProcessor: true,
    });

    expect(onSlashCommand).toHaveBeenCalledWith(promptText, undefined);
    expect(
      addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.USER && item.text === promptText,
      ),
    ).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
    expect(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[0]);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toMatchObject({
      prompt: promptText,
      skipInitialUserMessage: true,
    });
  });

  it('echoes queued command-style input that falls back to plain text', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const promptText = '/Users/demo/queued 分析这个项目';
    const addItem = vi.fn();
    const onSlashCommand = vi.fn(async () => false as const);
    const { result } = await renderOrchestrator(config, {
      addItem,
      onSlashCommand,
    });
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (commands, context) => {
        expect(commands).toMatchObject([
          {
            prompt: promptText,
            commandMode: 'prompt',
            origin: { kind: 'human' },
          },
        ]);
        const slashResult = await context.onSlashCommand?.(
          promptText,
          [],
          [],
          [],
        );
        expect(slashResult).toBe(false);
        return {
          messages: [
            {
              type: 'user',
              uuid: 'queued-processed-user-message',
              message: { role: 'user', content: promptText },
              origin: { kind: 'human' },
            } as Message,
          ],
          shouldQuery: true,
        };
      },
    );
    vi.mocked(query).mockClear();

    await result.current.submitQuery(promptText, {
      queuedCommands: [
        {
          prompt: promptText,
          commandMode: 'prompt',
          priority: 'next',
          origin: { kind: 'human' },
        },
      ],
      useInputProcessor: true,
    });

    expect(onSlashCommand).toHaveBeenCalledWith(promptText, undefined);
    expect(
      addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.USER && item.text === promptText,
      ),
    ).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[0]?.[0]).toMatchObject({
      prompt: promptText,
      skipInitialUserMessage: true,
    });
  });

  it('mirrors pasted images once when command-style input falls back to text', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const promptText = '/Users/demo/image [Image #1] 分析这个项目';
    const pastedContents = {
      1: {
        id: 1,
        type: 'image' as const,
        content: '',
        sourcePath: '/tmp/pasted-image.png',
      },
    };
    const materializedContents = {
      1: {
        ...pastedContents[1],
        content: 'base64-image',
        mediaType: 'image/png',
        isImageContentPrepared: true,
      },
    };
    const addItem = vi.fn();
    const onLocalUserMessage = vi.fn();
    const onSlashCommand = vi.fn(async () => false as const);
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config, {
      addItem,
      onLocalUserMessage,
      onSlashCommand,
    });
    vi.mocked(materializePastedContents).mockResolvedValueOnce(
      materializedContents,
    );
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const slashResult = await context.onSlashCommand?.(
          promptText,
          [],
          [],
          [],
        );
        expect(slashResult).toBe(false);
        return {
          messages: [
            {
              type: 'user',
              uuid: 'image-processed-user-message',
              message: { role: 'user', content: promptText },
              origin: { kind: 'human' },
            } as Message,
          ],
          shouldQuery: false,
        };
      },
    );

    await result.current.submitQuery(promptText, {
      pastedContents,
      useInputProcessor: true,
    });

    expect(materializePastedContents).toHaveBeenCalledWith(
      pastedContents,
      expect.any(AbortSignal),
    );
    expect(onSlashCommand).toHaveBeenCalledWith(
      promptText,
      materializedContents,
    );
    expect(
      addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.USER && item.text === promptText,
      ),
    ).toHaveLength(1);
    expect(onLocalUserMessage).toHaveBeenCalledTimes(1);
    expect(onLocalUserMessage).toHaveBeenCalledWith({
      text: promptText,
      contentBlocks: [
        { type: 'text', text: promptText },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: 'base64-image',
          },
        },
      ],
      uuid: expect.any(String),
    });
  });

  it('does not echo input handled by a known slash command', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const addItem = vi.fn();
    const onSlashCommand = vi.fn(async () => ({ type: 'handled' as const }));
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const { result } = await renderOrchestrator(config, {
      addItem,
      onSlashCommand,
    });
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        await context.onSlashCommand?.('/model', [], [], []);
        return {
          messages: [],
          shouldQuery: false,
        };
      },
    );
    vi.mocked(query).mockClear();

    await result.current.submitQuery('/model', {
      useInputProcessor: true,
    });

    expect(onSlashCommand).toHaveBeenCalledWith('/model', undefined);
    expect(applyMcpLazyLoad).not.toHaveBeenCalled();
    expect(
      addItem.mock.calls.some(([item]) => item.type === MessageType.USER),
    ).toBe(false);
  });

  it.each(['vision', 'non-vision', 'cancelled'] as const)(
    'checks image capability after readiness and cleans up %s input',
    async (scenario) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      let resolveReadiness!: () => void;
      const readiness = new Promise<void>((resolve) => {
        resolveReadiness = resolve;
      });
      const runtimeProjection = {
        ...NOOP_RUNTIME_PROJECTION,
        startTurn: vi.fn(),
        finishTurn: vi.fn(),
      };
      Object.assign(config, {
        getGoalManager: () => ({ isGoalActive: false }),
      });
      const vision = vi.mocked(isVisionSupportedModel).mockReturnValue(false);
      vision.mockClear();
      vi.mocked(executeUserInput).mockClear();
      vi.mocked(executeUserInput).mockResolvedValue({
        messages: [],
        shouldQuery: false,
      });
      const { result, onCancelSubmit } = await renderOrchestrator(config, {
        awaitSessionStartHooks: () => readiness,
        runtimeProjection,
      });
      const submission = result.current.submitUserInput(
        'describe @/tmp/startup-image.png',
      );
      await Promise.resolve();
      expect(vision).not.toHaveBeenCalled();
      expect(executeUserInput).not.toHaveBeenCalled();
      if (scenario === 'cancelled') result.current.cancelOngoingRequest();
      vision.mockReturnValue(scenario === 'vision');
      resolveReadiness();
      await submission;
      if (scenario === 'vision') {
        expect(vision).toHaveBeenCalledWith(
          expect.objectContaining({ key: 'test-model' }),
        );
        expect(executeUserInput).toHaveBeenCalledOnce();
      } else {
        expect(executeUserInput).not.toHaveBeenCalled();
        expect(runtimeProjection.finishTurn).toHaveBeenCalled();
        if (scenario === 'non-vision')
          expect(onCancelSubmit).toHaveBeenCalledWith(true);
      }
      vision.mockReturnValue(true);
    },
  );

  it('claims a normal model turn before startup readiness completes', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let resolveReadiness!: () => void;
    const readiness = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      startTurn: vi.fn(),
      handleInputResolved: vi.fn(),
      finishTurn: vi.fn(),
    };
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: true,
    });
    const { result } = await renderOrchestrator(config, {
      awaitSessionStartHooks: vi.fn(() => readiness),
      runtimeProjection,
    });

    const submission = result.current.submitQuery('explain this code', {
      useInputProcessor: true,
    });

    expect(runtimeProjection.startTurn).toHaveBeenCalledWith({
      modelTurnActive: true,
    });
    expect(runtimeProjection.handleInputResolved).not.toHaveBeenCalled();

    resolveReadiness();
    await submission;

    expect(runtimeProjection.handleInputResolved).toHaveBeenCalledWith(true);
  });

  it('shows startup readiness as transient progress instead of feed history', async () => {
    vi.useFakeTimers();
    try {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      let resolveReadiness!: () => void;
      const readiness = new Promise<void>((resolve) => {
        resolveReadiness = resolve;
      });
      const addItem = vi.fn();
      const onStartupWaitingChange = vi.fn();
      const { result } = await renderOrchestrator(config, {
        addItem,
        awaitSessionStartHooks: vi.fn(() => readiness),
        onStartupWaitingChange,
      });

      const submission = result.current.submitQuery('explain this code');
      await vi.advanceTimersByTimeAsync(300);

      expect(onStartupWaitingChange).toHaveBeenCalledWith(true);
      expect(addItem).not.toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Preparing project context'),
        }),
        expect.anything(),
      );

      resolveReadiness();
      await submission;

      expect(onStartupWaitingChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the shared human-input rule for raw TUI task triggers', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    vi.mocked(query).mockClear();
    vi.mocked(isHumanTaskInputMessage).mockClear();

    await result.current.submitQuery('explain this code');

    expect(isHumanTaskInputMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user',
        origin: { kind: 'human' },
        humanInput: {
          text: 'explain this code',
          mode: 'prompt',
        },
      }),
    );
    expect(vi.mocked(query).mock.calls[0]?.[0]).toMatchObject({
      taskTrigger: 'user_prompt',
      userMessageSubmittedAtMs: expect.any(Number),
    });

    vi.mocked(query).mockClear();
    await result.current.submitQuery('internal follow-up', { isMeta: true });

    expect(vi.mocked(query).mock.calls[0]?.[0]).toMatchObject({
      taskTrigger: 'continuation',
      userMessageSubmittedAtMs: undefined,
    });
  });

  it('waits for the first managed policy before submitting a TUI request', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({ directories: [mainRoot], targetDir: mainRoot });
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    const whenReady = vi.fn(() => ready);
    config.getProcessPermissionManager = vi.fn(() => ({
      getManagedPolicy: () => ({ whenReady }),
    })) as unknown as Config['getProcessPermissionManager'];
    let restricted = false;
    config.getPermissionModeRestriction = vi.fn(() => restricted ? 'Host policy restriction' : undefined);
    vi.mocked(parseAndFormatApiErrorMessage).mockImplementation((error) =>
      error instanceof Error ? error.message : String(error),
    );
    const onCoreEvent = vi.fn();
    const { result } = await renderOrchestrator(config, { onCoreEvent });
    vi.mocked(query).mockClear();
    vi.mocked(executeUserInput).mockClear();
    const submission = result.current.submitQuery('test first request', { useInputProcessor: true });
    try {
      await waitFor(() => expect(whenReady).toHaveBeenCalled());
      expect(query).not.toHaveBeenCalled();
      expect(executeUserInput).not.toHaveBeenCalled();
      restricted = true;
      finish();
      await submission;
      expect(query).not.toHaveBeenCalled();
      expect(executeUserInput).not.toHaveBeenCalled();
      expect(onCoreEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error_notification', message: 'Host policy restriction',
      }));
    } finally {
      finish();
      await submission;
    }
  });

  it.each(['yolo', 'auto'] as const)(
    'blocks a message in restricted %s mode and permits a new message after reopening',
    async (mode) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const message = `企业管理员已禁用${mode}模式，如需开启，请联系您所在企业的管理员`;
      vi.mocked(parseAndFormatApiErrorMessage).mockImplementation((error) =>
        error instanceof Error ? error.message : String(error),
      );
      let restricted = true;
      config.getPermissionMode = vi.fn(() => mode);
      config.getPermissionModeRestriction = vi.fn(() =>
        restricted ? message : undefined,
      );
      const addItem = vi.fn();
      const onTurnComplete = vi.fn();
      const onCoreEvent = vi.fn();
      const { result } = await renderOrchestrator(config, {
        addItem,
        onTurnComplete,
        onCoreEvent,
      });
      vi.mocked(query).mockClear();
      vi.mocked(executeUserInput).mockClear();

      await result.current.submitQuery('explain this code', {
        useInputProcessor: true,
      });

      expect(query).not.toHaveBeenCalled();
      expect(executeUserInput).not.toHaveBeenCalled();
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.ERROR, text: message }),
      );
      expect(onTurnComplete).toHaveBeenCalledOnce();
      expect(onCoreEvent).toHaveBeenCalledWith({
        type: 'error_notification',
        error_type: 'submission_failed',
        message,
        timestamp: expect.any(String),
      });
      expect(onCoreEvent.mock.invocationCallOrder[0]).toBeLessThan(
        onTurnComplete.mock.invocationCallOrder[0],
      );
      expect(config.getPermissionMode()).toBe(mode);
      restricted = false;
      await result.current.submitQuery('new message');
      expect(query).toHaveBeenCalledOnce();
      expect(onTurnComplete).toHaveBeenCalledTimes(2);
    },
  );

  it('reports a policy rejection after input preparation before completing the turn once', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const message = 'Mode disabled after input preparation';
    vi.mocked(parseAndFormatApiErrorMessage).mockImplementation((error) =>
      error instanceof Error ? error.message : String(error),
    );
    config.getPermissionModeRestriction = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(message);
    const onTurnComplete = vi.fn();
    const onCoreEvent = vi.fn();
    const { result } = await renderOrchestrator(config, {
      onTurnComplete,
      onCoreEvent,
    });
    vi.mocked(query).mockClear();
    await result.current.submitQuery('test policy update');
    expect(query).not.toHaveBeenCalled();
    expect(onCoreEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error_notification', message }),
    );
    expect(onTurnComplete).toHaveBeenCalledOnce();
    expect(onCoreEvent.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnComplete.mock.invocationCallOrder[0],
    );
  });

  it('does not complete an existing turn when a busy session rejects a new submission', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onTurnComplete = vi.fn();
    const runtimeProjection = {
      ...NOOP_RUNTIME_PROJECTION,
      getStreamingState: () => StreamingState.Responding,
      finishTurn: vi.fn(),
    };
    const { result } = await renderOrchestrator(config, {
      runtimeProjection,
      onTurnComplete,
    });
    await result.current.submitQuery('not admitted');
    expect(onTurnComplete).not.toHaveBeenCalled();
    expect(runtimeProjection.finishTurn).not.toHaveBeenCalled();
  });

  it('keeps local slash commands available in a restricted mode', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    config.getPermissionMode = vi.fn(() => 'yolo' as const);
    config.getPermissionModeRestriction = vi.fn(() => 'Mode restricted');
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    const { result } = await renderOrchestrator(config);
    vi.mocked(query).mockClear();
    await result.current.submitQuery('/help', { useInputProcessor: true });
    expect(executeUserInput).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('applies the MCP lazy-load experiment when a raw TUI task starts', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('explain this code');

    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
  });

  it('keeps local slash commands outside model progress', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      startTurn: vi.fn(),
      handleInputResolved: vi.fn(),
    };
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });
    const { result } = await renderOrchestrator(config, {
      runtimeProjection,
    });

    await result.current.submitQuery('/help', {
      useInputProcessor: true,
    });

    expect(runtimeProjection.startTurn).toHaveBeenCalledWith({
      modelTurnActive: false,
    });
    expect(runtimeProjection.handleInputResolved).toHaveBeenCalledWith(false);
  });

  it('promotes model-backed slash commands from the shared shouldQuery result', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      startTurn: vi.fn(),
      handleInputResolved: vi.fn(),
    };
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const onSlashCommand = vi.fn(async () => ({
      type: 'submit_prompt' as const,
      content: 'review current changes',
    }));
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const processed = await context.onSlashCommand?.(
          '/review current changes',
          [],
          [],
          [],
        );
        expect(processed).not.toBe(false);
        return processed as Exclude<typeof processed, false | undefined>;
      },
    );
    const { result } = await renderOrchestrator(config, {
      runtimeProjection,
      onSlashCommand,
    });

    await result.current.submitQuery('/review current changes', {
      useInputProcessor: true,
    });

    expect(runtimeProjection.startTurn).toHaveBeenCalledWith({
      modelTurnActive: false,
    });
    expect(runtimeProjection.handleInputResolved).toHaveBeenCalledWith(true);
    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
    expect(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[0]);
  });

  it('records a submitted prompt the user typed in a dialog as their words', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const onSlashCommand = vi.fn(async () => ({
      type: 'submit_prompt' as const,
      content: 'Only check the migration scripts.',
      isMeta: true,
      isUserDecision: true,
    }));
    let recorded: unknown;
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const processed = await context.onSlashCommand?.('/review', [], [], []);
        expect(processed).not.toBe(false);
        recorded = (processed as { messages: unknown[] }).messages;
        return processed as Exclude<typeof processed, false | undefined>;
      },
    );
    const { result } = await renderOrchestrator(config, { onSlashCommand });

    await result.current.submitQuery('/review', { useInputProcessor: true });

    expect(recorded).toEqual([
      expect.objectContaining({
        type: 'user',
        isMeta: true,
        isUserDecision: true,
        origin: { kind: 'human' },
      }),
    ]);
  });

  it('locks the MCP experiment before a scheduled tool post-submit prompt', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    const onSlashCommand = vi.fn(async () => ({
      type: 'schedule_tool' as const,
      postSubmitPrompt: 'continue after the scheduled tool',
    }));
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const processed = await context.onSlashCommand?.('/init', [], [], []);
        expect(processed).not.toBe(false);
        return processed as Exclude<typeof processed, false | undefined>;
      },
    );
    const { result } = await renderOrchestrator(config, { onSlashCommand });

    await result.current.submitQuery('/init', {
      useInputProcessor: true,
    });

    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
    expect(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[0]);
  });

  it('locks the MCP experiment after a completed bash outcome and before the model', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onBashCommand = vi.fn(async () => ({
      kind: 'completed' as const,
      command: 'pwd',
      displayOutput: mainRoot,
      modelOutput: { stdout: mainRoot, stderr: '' },
      exitCode: 0,
      signal: null,
    }));
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const processed = await context.onBashCommand?.('pwd', []);
        expect(processed).toBeDefined();
        return processed!;
      },
    );
    const { result } = await renderOrchestrator(config, {
      onBashCommand,
      respondToBashCommands: true,
    });

    await result.current.submitQuery('pwd', {
      commandMode: 'bash',
      useInputProcessor: true,
    });

    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
    expect(onBashCommand.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[0]);
  });

  it('does not lock the MCP experiment for a bash command with model responses disabled', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onBashCommand = vi.fn(async () => ({
      kind: 'completed' as const,
      command: 'pwd',
      displayOutput: mainRoot,
      modelOutput: { stdout: mainRoot, stderr: '' },
      exitCode: 0,
      signal: null,
    }));
    vi.mocked(executeUserInput).mockImplementationOnce(
      async (_commands, context) => {
        const processed = await context.onBashCommand?.('pwd', []);
        expect(processed).toBeDefined();
        return processed!;
      },
    );
    const { result } = await renderOrchestrator(config, {
      onBashCommand,
      respondToBashCommands: false,
    });

    await result.current.submitQuery('pwd', {
      commandMode: 'bash',
      useInputProcessor: true,
    });

    expect(applyMcpLazyLoad).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'backgrounded',
      outcome: {
        kind: 'backgrounded' as const,
        command: 'sleep 30',
        pid: 123,
        displayOutput: 'backgrounded',
        modelOutput: { stdout: '', stderr: '' },
      },
    },
    {
      name: 'cancelled',
      outcome: {
        kind: 'cancelled' as const,
        command: 'sleep 30',
        displayOutput: 'cancelled',
        modelOutput: { stdout: '', stderr: 'cancelled' },
        timedOut: false,
      },
    },
    { name: 'missing', outcome: undefined },
  ])(
    'does not lock the MCP experiment for a $name bash outcome',
    async ({ outcome }) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const onBashCommand = vi.fn(async () => outcome);
      vi.mocked(executeUserInput).mockImplementationOnce(
        async (_commands, context) => {
          const processed = await context.onBashCommand?.('sleep 30', []);
          expect(processed).toBeDefined();
          return processed!;
        },
      );
      const { result } = await renderOrchestrator(config, {
        onBashCommand,
        respondToBashCommands: true,
      });

      await result.current.submitQuery('sleep 30', {
        commandMode: 'bash',
        useInputProcessor: true,
      });

      expect(applyMcpLazyLoad).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('uses the final processor result as a catch-all model request boundary', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: true,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('/future-model-command', {
      useInputProcessor: true,
    });

    const inputContext = vi.mocked(executeUserInput).mock.calls[0][1];
    const queryOptions = vi.mocked(query).mock.calls[0][0];
    expect(inputContext.taskId).toEqual(expect.any(String));
    expect(inputContext.taskId).toBe(queryOptions.preallocatedRequestSetId);
    expect(inputContext.promptId).toBe(queryOptions.promptId);

    expect(applyMcpLazyLoad).toHaveBeenCalledWith(config);
    expect(
      vi.mocked(executeUserInput).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(applyMcpLazyLoad).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(query).mock.invocationCallOrder[0]);
  });

  it.each(['SessionStart', 'request configuration'])(
    'restores a non-slash prompt when startup readiness fails in %s',
    async (failureSource) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const addItem = vi.fn();
      const onCancelSubmit = vi.fn();
      if (failureSource === 'request configuration') {
        vi.mocked(ensureConfigReadyForRequest).mockRejectedValueOnce(
          new Error('configuration readiness boom'),
        );
      }
      const runtimeProjection: RuntimeProjectionController = {
        ...NOOP_RUNTIME_PROJECTION,
        startTurn: vi.fn(),
        finishTurn: vi.fn(),
      };
      const { result } = await renderOrchestrator(config, {
        addItem,
        onCancelSubmit,
        runtimeProjection,
        awaitSessionStartHooks: vi.fn(async () => {
          if (failureSource === 'SessionStart')
            throw new Error('startup readiness boom');
        }),
      });

      await result.current.submitQuery('keep this prompt');

      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'keep this prompt' }),
      );
      expect(onCancelSubmit).toHaveBeenCalledWith(true);
      expect(runtimeProjection.startTurn).toHaveBeenCalledWith({
        modelTurnActive: true,
      });
      expect(runtimeProjection.finishTurn).toHaveBeenCalledOnce();
    },
  );

  it('strips API Error wrapper from terminal error history text', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const expectedMessage =
      'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue';
    vi.mocked(parseAndFormatApiErrorMessage).mockReturnValue(expectedMessage);
    vi.mocked(query).mockImplementation(async function* () {
      yield* [];
      return {
        reason: 'error',
        error: new Error('raw api error'),
      };
    } as never);
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, { addItem });

    await result.current.submitQuery('hello');

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: expectedMessage,
      },
      expect.any(Number),
      true,
    );
  });

  it('uses the configured TUI turn limit and supports unlimited runs', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const configured = await renderOrchestrator(config, { maxTurns: 2000 });

    await configured.result.current.submitQuery('keep working');

    expect(vi.mocked(query).mock.calls[0]?.[0]?.maxTurns).toBe(2000);

    vi.mocked(query).mockClear();
    const unlimited = await renderOrchestrator(config, {
      maxTurns: 'unlimited',
    });
    await unlimited.result.current.submitQuery('keep working forever');

    expect(vi.mocked(query).mock.calls[0]?.[0]?.maxTurns).toBeUndefined();
  });

  it('explains a TUI max-turn stop as a warning', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(query).mockImplementation(async function* () {
      yield* [];
      return { reason: 'max_turns' };
    } as never);
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, {
      addItem,
      maxTurns: 2000,
    });

    await result.current.submitQuery('long task');

    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.WARNING,
        text: expect.stringMatching(/2000-turn limit.*type "continue"/),
      },
      expect.any(Number),
    );
  });

  it('seeds startup static memory read-state for new attachment contexts', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(seedStartupStaticMemoryFileReadState).mockReturnValue(1);
    const { result } = await renderOrchestrator(config);

    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    expect(seedStartupStaticMemoryFileReadState).toHaveBeenCalledTimes(2);

    await result.current.submitQuery('hello');

    expect(seedStartupStaticMemoryFileReadState).toHaveBeenCalledTimes(2);
    expect(getAttachmentMessages).toHaveBeenCalled();
    expect(
      vi.mocked(seedStartupStaticMemoryFileReadState).mock
        .invocationCallOrder[1],
    ).toBeLessThan(
      vi.mocked(getAttachmentMessages).mock.invocationCallOrder[0],
    );
  });

  it('records durable attachments generated on the raw input path', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const reminder = {
      type: 'attachment',
      uuid: 'task-reminder-message',
      timestamp: '2026-08-03T00:00:00.000Z',
      attachment: {
        type: 'task_reminder',
        content: [],
        itemCount: 0,
      },
    } as Message;
    vi.mocked(getAttachmentMessages).mockResolvedValueOnce([reminder as never]);
    vi.mocked(isChainParticipant).mockImplementation(
      (message) =>
        message.type === 'attachment' &&
        message.attachment.type === 'task_reminder',
    );
    vi.mocked(query).mockImplementation(async function* (options: {
      userMessage?: { uuid?: string };
      promptId?: string;
      initialInputAttachments?: Message[];
    }) {
      yield {
        type: 'user',
        uuid: options.userMessage?.uuid ?? 'human-message',
        timestamp: '2026-08-03T00:00:00.000Z',
        promptId: options.promptId,
        message: {
          role: 'user',
          content: 'continue the task',
        },
      } as Message;
      for (const attachment of options.initialInputAttachments ?? []) {
        yield attachment;
      }
      return { reason: 'end_turn' };
    } as never);
    const { result } = await renderOrchestrator(config);

    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const writer = coreMocks.transcriptWriterInstances.at(-1);
    writer?.recordMessages?.mockClear();

    await result.current.submitQuery('continue the task');

    expect(writer?.recordMessages?.mock.calls).toHaveLength(2);
    const persistedUser = writer?.recordMessages?.mock.calls[0]?.[0]?.[0] as
      | Message
      | undefined;
    expect(persistedUser?.type).toBe('user');
    expect(writer?.recordMessages).toHaveBeenLastCalledWith([reminder]);
  });

  describe('raw input reminder baseline', () => {
    const lazyReminder = {
      type: 'attachment',
      uuid: 'lazy-mcp-reminder',
      timestamp: '2026-10-17T00:00:00.000Z',
      attachment: {
        type: 'mcp_lazy_tools_delta',
        content: 'catalog',
        isInitial: true,
        addedNames: ['mcp__files__read'],
        removedNames: [],
      },
    } as Message;

    function announceCatalogWhenMissing() {
      vi.mocked(getAttachmentMessages).mockImplementation((async (
        _prompt: string,
        ctx: AttachmentToolUseContext,
      ) => {
        if (ctx.announcedLazyMcpTools.has('mcp__files__read')) return [];
        ctx.announcedLazyMcpTools.add('mcp__files__read');
        return [lazyReminder];
      }) as never);
      vi.mocked(isChainParticipant).mockImplementation(
        (message) => message.type === 'attachment',
      );
    }

    function userEvent(options: {
      userMessage?: { uuid?: string };
      promptId?: string;
    }): Message {
      return {
        type: 'user',
        uuid: options.userMessage?.uuid ?? 'human-message',
        timestamp: '2026-10-17T00:00:00.000Z',
        promptId: options.promptId,
        message: { role: 'user', content: 'hello' },
      } as Message;
    }

    type QueryOptions = {
      userMessage?: { uuid?: string };
      promptId?: string;
      initialInputAttachments?: Message[];
    };

    const endsBeforeAttachments: Array<
      [string, (options: QueryOptions) => AsyncGenerator<Message>]
    > = [
      [
        'a hook blocks the prompt',
        async function* () {
          // A blocked prompt yields only the hook's own attachments, if any.
          yield* [] as Message[];
          return { reason: 'error' };
        } as never,
      ],
      [
        'a hook stops the prompt',
        async function* (options: QueryOptions) {
          yield userEvent(options);
          return { reason: 'end_turn' };
        } as never,
      ],
    ];

    it.each(endsBeforeAttachments)(
      're-sends the reminder after %s',
      async (_label, endedQuery) => {
        const { mainRoot } = createDirs();
        const { config } = createConfig({
          directories: [mainRoot],
          targetDir: mainRoot,
        });
        announceCatalogWhenMissing();
        vi.mocked(query)
          .mockImplementationOnce(endedQuery as never)
          .mockImplementationOnce(async function* (options: QueryOptions) {
            yield userEvent(options);
            for (const attachment of options.initialInputAttachments ?? []) {
              yield attachment;
            }
            return { reason: 'end_turn' };
          } as never);
        const { result } = await renderOrchestrator(config);

        await result.current.submitQuery('hello');
        await result.current.submitQuery('hello');

        const secondCall = vi.mocked(query).mock.calls.at(-1)?.[0];
        expect(secondCall?.initialInputAttachments).toEqual([lazyReminder]);
      },
    );

    it.each(['return', 'throw', 'write-failure'] as const)(
      'preserves accepted Skill delivery and retries only MCP after partial %s',
      async (failureKind) => {
        const { mainRoot } = createDirs();
        const { config } = createConfig({
          directories: [mainRoot],
          targetDir: mainRoot,
        });
        const skillMessage = {
          type: 'attachment',
          uuid: 'accepted-skill',
          timestamp: '2026-10-18T00:00:00Z',
          attachment: {
            type: 'skill_listing',
            content: '- alpha: skill',
            names: ['alpha'],
            skillCount: 1,
            isInitial: true,
          },
        } as Message;
        let attachmentCtx: AttachmentToolUseContext | undefined;
        vi.mocked(getAttachmentMessages).mockImplementation((async (
          _input: string,
          ctx: AttachmentToolUseContext,
        ) => {
          attachmentCtx = ctx;
          const out: Message[] = [];
          if (!ctx.sentSkillNames.get(ctx.agentId ?? 'main')?.has('alpha')) {
            ctx.sentSkillNames.set(ctx.agentId ?? 'main', new Set(['alpha']));
            ctx.sentSkillListingFingerprints = new Map([
              [ctx.agentId ?? 'main', 'generated-fingerprint'],
            ]);
            out.push(skillMessage);
          }
          if (!ctx.announcedLazyMcpTools.has('mcp__files__read')) {
            ctx.announcedLazyMcpTools.add('mcp__files__read');
            out.push(lazyReminder);
          }
          return out;
        }) as never);
        vi.mocked(isChainParticipant).mockImplementation(
          (m) => m.type === 'attachment',
        );
        vi.mocked(query)
          .mockImplementationOnce(async function* (options: QueryOptions) {
            yield userEvent(options);
            yield options.initialInputAttachments![0];
            if (failureKind === 'throw')
              throw new Error('consumer interrupted between attachments');
            if (failureKind === 'write-failure') {
              for (const attachment of options.initialInputAttachments!.slice(
                1,
              ))
                yield attachment;
            }
            return { reason: 'end_turn' };
          } as never)
          .mockImplementation(async function* (options: QueryOptions) {
            yield userEvent(options);
            for (const attachment of options.initialInputAttachments ?? [])
              yield attachment;
            return { reason: 'end_turn' };
          } as never);
        const { result } = await renderOrchestrator(config);
        if (failureKind === 'write-failure') {
          await result.current.replaceMessages([], config.getSessionId(), {
            restoreExistingSession: true,
            transcriptProjectRoot: mainRoot,
          });
          const writer = coreMocks.transcriptWriterInstances.at(-1)!;
          writer.recordMessages!.mockImplementation(
            async (messages: Message[]) => {
              if (messages.some((m) => m.uuid === 'accepted-skill'))
                throw new Error('disk full');
              return messages.at(-1)?.uuid ?? null;
            },
          );
        }
        await result.current.submitQuery('first');
        if (failureKind !== 'write-failure') {
          expect([
            ...attachmentCtx!.sentSkillNames.get(
              attachmentCtx!.agentId ?? 'main',
            )!,
          ]).toEqual(['alpha']);
          expect(attachmentCtx!.announcedLazyMcpTools.size).toBe(0);
        }
        if (failureKind === 'write-failure') {
          coreMocks.transcriptWriterInstances
            .at(-1)
            ?.recordMessages?.mockImplementation(
              async (messages: Message[]) => messages.at(-1)?.uuid ?? null,
            );
        }
        await result.current.submitQuery('retry');
        const expected = failureKind === 'write-failure' ? [] : [lazyReminder];
        expect(
          vi.mocked(query).mock.calls.at(-1)?.[0].initialInputAttachments,
        ).toEqual(expected);
        await result.current.submitQuery('stable');
        expect(
          vi.mocked(query).mock.calls.at(-1)?.[0].initialInputAttachments,
        ).toEqual([]);
      },
    );

    it('closes the query with the consumer error when projection interrupts delivery', async () => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const failure = new Error('projection failed');
      const closed = vi.fn();
      const finalized = vi.fn();
      vi.mocked(query).mockImplementation(async function* () {
        try {
          yield {
            type: 'assistant',
            uuid: 'failed-projection',
            timestamp: '2026-10-18T00:00:00Z',
            message: {
              id: 'failed-projection',
              type: 'message',
              role: 'assistant',
              stop_sequence: null,
              container: null,
              context_management: null,
              stop_reason: null,
              model: 'test-model',
              content: [{ type: 'text', text: 'answer' }],
            },
          } satisfies Message;
          return { reason: 'end_turn' };
        } catch (error) {
          closed(error);
          throw error;
        } finally {
          finalized();
        }
      } as never);
      const { result } = await renderOrchestrator(config, {
        runtimeProjection: {
          ...NOOP_RUNTIME_PROJECTION,
          handleAssistantMessage: () => {
            throw failure;
          },
        },
      });
      await result.current.submitQuery('hello');
      expect(closed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(finalized).toHaveBeenCalledOnce();
    });

    it('keeps the baseline once the reminder is yielded', async () => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      announceCatalogWhenMissing();
      vi.mocked(query).mockImplementation(async function* (
        options: QueryOptions,
      ) {
        yield userEvent(options);
        for (const attachment of options.initialInputAttachments ?? []) {
          yield attachment;
        }
        return { reason: 'end_turn' };
      } as never);
      const { result } = await renderOrchestrator(config);

      await result.current.submitQuery('hello');
      await result.current.submitQuery('hello');

      const secondCall = vi.mocked(query).mock.calls.at(-1)?.[0];
      expect(secondCall?.initialInputAttachments).toEqual([]);
    });
  });

  it('uses the shared discovery config and callable Skill set on raw TUI input', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const listingConfig = { preserveNames: true, columnsPerToken: 3 as const };
    // The shared helper's behavior is covered in core. This checks the raw
    // input route actually forwards its result instead of assembling legacy options.
    vi.mocked(getSkillListingConfig).mockResolvedValue(listingConfig);
    vi.mocked(getModelVisibleSkillsForTools).mockReturnValue(null);
    const { result } = await renderOrchestrator(config);
    await result.current.submitQuery('continue the workflow', { isMeta: true });

    expect(getSkillListingConfig).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        model: 'test-model',
      }),
    );
    expect(getModelVisibleSkillsForTools).toHaveBeenCalledWith(config, []);
    expect(
      vi.mocked(query).mock.calls.at(-1)?.[0].toolRegistry?.getSchema,
    ).toHaveBeenCalledWith('test-model');
    const call = vi.mocked(getAttachmentMessages).mock.calls.at(-1)!;
    expect(call[3]).toBeNull();
    expect(call[4]?.skillListingConfig).toBe(listingConfig);
  });

  it('starts ai-title generation from the first real prompt before the turn completes', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onProvisionalSessionTitle = vi.fn();
    const { result } = await renderOrchestrator(config, {
      onProvisionalSessionTitle,
    });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });

    await result.current.submitQuery('fix terminal tab titles', {
      countTowardsAiTitleCadence: true,
    });

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        description: 'fix terminal tab titles',
        signal: expect.any(AbortSignal),
      }),
    );
    const titleBusiness = vi.mocked(generateSessionTitleForCurrentSession).mock
      .calls[0]?.[0].businessInfo;
    const mainQuery = vi.mocked(query).mock.calls[0]?.[0];
    expect(titleBusiness?.id).toBeTruthy();
    expect(titleBusiness?.model_key).toBe('test-model');
    expect(titleBusiness?.id).toBe(mainQuery?.businessInfo?.id);
    expect(titleBusiness?.id).toBe(mainQuery?.userMessage?.requestSetId);
    expect(onProvisionalSessionTitle).toHaveBeenCalledWith(
      'fix terminal tab titles',
    );
  });

  it('retains the first title business model while a later turn selects another model', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const titleGate = deferred<void>();
    vi.mocked(generateSessionTitleForCurrentSession).mockImplementationOnce(
      () => titleGate.promise,
    );
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    vi.mocked(config.getModel).mockReturnValue('ultimate');
    await result.current.submitQuery('first turn', {
      countTowardsAiTitleCadence: true,
    });
    const firstTitle = vi.mocked(generateSessionTitleForCurrentSession).mock
      .calls[0][0].businessInfo;
    vi.mocked(config.getModel).mockReturnValue('auto');
    await result.current.submitQuery('second turn');
    const secondBusiness = vi.mocked(query).mock.calls.at(-1)?.[0].businessInfo;
    expect(firstTitle?.model_key).toBe('ultimate');
    expect(secondBusiness?.model_key).toBe('auto');
    expect(secondBusiness?.id).not.toBe(firstTitle?.id);
    titleGate.resolve();
    await titleGate.promise;
    expect(firstTitle?.model_key).toBe('ultimate');
  });

  it('does not generate an ai-title for a local slash command', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onProvisionalSessionTitle = vi.fn();
    const { result } = await renderOrchestrator(config, {
      onProvisionalSessionTitle,
    });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    vi.mocked(generateSessionTitleForCurrentSession).mockClear();
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: false,
    });

    await result.current.submitQuery('/help', {
      countTowardsAiTitleCadence: true,
      useInputProcessor: true,
    });

    expect(generateSessionTitleForCurrentSession).not.toHaveBeenCalled();
    expect(onProvisionalSessionTitle).not.toHaveBeenCalled();
  });

  it('generates an ai-title for a model-backed slash command', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const onProvisionalSessionTitle = vi.fn();
    const { result } = await renderOrchestrator(config, {
      onProvisionalSessionTitle,
    });
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    vi.mocked(generateSessionTitleForCurrentSession).mockClear();
    vi.mocked(isCommandStyleUserPromptText).mockReturnValue(true);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: true,
    });

    await result.current.submitQuery('/review current changes', {
      countTowardsAiTitleCadence: true,
      useInputProcessor: true,
    });

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        description: '/review current changes',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(onProvisionalSessionTitle).toHaveBeenCalledWith(
      '/review current changes',
    );
  });

  it('keeps the first prompt title request alive when the turn completes', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let finishEarlyTitle: (() => void) | undefined;
    vi.mocked(generateSessionTitleForCurrentSession).mockClear();
    vi.mocked(generateSessionTitleForCurrentSession).mockImplementationOnce(
      ({ onTitleWritten }) =>
        new Promise<void>((resolve) => {
          finishEarlyTitle = () => {
            onTitleWritten?.('Improve terminal titles', 'fresh-ai');
            resolve();
          };
        }),
    );
    mockSuccessfulAssistantTurns(config);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });

    await result.current.submitQuery('improve terminal titles', {
      countTowardsAiTitleCadence: true,
    });

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(1);
    const firstSignal = vi.mocked(generateSessionTitleForCurrentSession).mock
      .calls[0]?.[0].signal;
    expect(firstSignal?.aborted).toBe(false);

    finishEarlyTitle?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('retries title generation on the next meaningful prompt after both first-turn attempts fail', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(generateSessionTitleForCurrentSession).mockReset();
    vi.mocked(generateSessionTitleForCurrentSession).mockResolvedValue(
      undefined,
    );
    mockSuccessfulAssistantTurns(config);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });

    await result.current.submitQuery('first prompt', {
      countTowardsAiTitleCadence: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(2);

    await result.current.submitQuery('second prompt', {
      countTowardsAiTitleCadence: true,
    });

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(4);
    expect(generateSessionTitleForCurrentSession).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        description: 'second prompt',
      }),
    );
  });

  it('does not regenerate a written local title on the third prompt', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(generateSessionTitleForCurrentSession).mockReset();
    vi.mocked(generateSessionTitleForCurrentSession).mockImplementation(
      async ({ onTitleWritten }) => {
        onTitleWritten?.('Stable title', 'fresh-ai');
      },
    );
    mockSuccessfulAssistantTurns(config);
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], config.getSessionId(), {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });

    await result.current.submitQuery('first prompt', {
      countTowardsAiTitleCadence: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const callsAfterFirstTurn = vi.mocked(generateSessionTitleForCurrentSession)
      .mock.calls.length;

    await result.current.submitQuery('second prompt', {
      countTowardsAiTitleCadence: true,
    });
    await result.current.submitQuery('third prompt', {
      countTowardsAiTitleCadence: true,
    });

    expect(generateSessionTitleForCurrentSession).toHaveBeenCalledTimes(
      callsAfterFirstTurn,
    );
  });

  it('passes the complete generic TUI prompt suggestion override without plugin contributions', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('finish the code change');
    await new Promise((resolve) => setImmediate(resolve));

    const suggestionRequest = coreMocks.tryGeneratePromptSuggestion.mock
      .calls[0]?.[0] as
      | { systemPromptOverride?: string; businessInfo?: { id?: string } }
      | undefined;
    expect(suggestionRequest?.businessInfo?.id).toBeTruthy();
    expect(suggestionRequest?.businessInfo?.id).toBe(
      vi.mocked(query).mock.calls[0]?.[0].businessInfo?.id,
    );
    expect(suggestionRequest?.systemPromptOverride).toContain(
      "You generate optional next-action suggestions for a general local AI agent's TUI",
    );
    expect(suggestionRequest?.systemPromptOverride).not.toContain(
      '## Example plugin guidance',
    );
    expect(suggestionRequest?.systemPromptOverride).toContain(
      'Return up to 3 short, distinct instructions',
    );
  });

  it.each([
    { mode: 'legacy', forkEnabled: false },
    { mode: 'legacy', forkEnabled: true },
    { mode: 'shared', forkEnabled: false },
    { mode: 'shared', forkEnabled: true },
  ] as const)(
    'delivers only the first non-empty prompt suggestion in $mode with forkEnabled=$forkEnabled',
    async ({ mode, forkEnabled }) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
        enabled: true,
        mode,
        forkEnabled,
      });
      if (forkEnabled) {
        coreMocks.capturePromptSuggestionForkSource.mockImplementationOnce(
          (_config, _promptId, _requestSetId, isCurrent) => ({ isCurrent }),
        );
      }
      coreMocks.tryGeneratePromptSuggestion.mockResolvedValueOnce({
        suggestion:
          '\n  \n  run the focused tests  \n\nrun the focused tests\ninspect the diff\nprepare a summary\n',
      });
      const onPromptSuggestions = vi.fn();
      const { result } = await renderOrchestrator(config, {
        onPromptSuggestions,
      });

      await result.current.submitQuery('finish the code change');
      await waitFor(() => {
        expect(onPromptSuggestions).toHaveBeenCalledExactlyOnceWith(
          ['run the focused tests'],
          expect.any(String),
        );
      });
      expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce();
      const request = coreMocks.tryGeneratePromptSuggestion.mock.calls[0]?.[0];
      expect(onPromptSuggestions.mock.calls[0]?.[1]).toBe(request.promptId);
      if (forkEnabled) {
        expect(request.forkSource.isCurrent()).toBe(true);
        expect(
          coreMocks.capturePromptSuggestionForkSource,
        ).toHaveBeenCalledWith(
          config,
          request.promptId,
          expect.any(String),
          expect.any(Function),
        );
      }
      expect(request.systemPromptOverride).toEqual(
        mode === 'legacy' ? expect.any(String) : undefined,
      );
    },
  );

  it.each([
    { mode: 'legacy', forkEnabled: false },
    { mode: 'legacy', forkEnabled: true },
    { mode: 'shared', forkEnabled: false },
    { mode: 'shared', forkEnabled: true },
  ] as const)(
    'skips fork capture after hook_stopped in $mode with forkEnabled=$forkEnabled',
    async ({ mode, forkEnabled }) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
        enabled: true,
        mode,
        forkEnabled,
      });
      coreMocks.capturePromptSuggestionForkSource.mockImplementation(
        (_config, _promptId, _requestSetId, isCurrent) => ({ isCurrent }),
      );
      coreMocks.tryGeneratePromptSuggestion.mockResolvedValueOnce({
        suggestion: 'run the tests',
      });
      vi.mocked(query).mockImplementationOnce(async function* () {
        yield* [];
        return { reason: 'end_turn', terminalDetail: 'hook_stopped' };
      } as never);
      const onPromptSuggestions = vi.fn();
      const { result } = await renderOrchestrator(config, {
        onPromptSuggestions,
      });
      await result.current.submitQuery('finish the code change');
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        coreMocks.capturePromptSuggestionForkSource,
      ).not.toHaveBeenCalled();
      expect(
        coreMocks.tryGeneratePromptSuggestion,
      ).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ forkSource: undefined }),
      );
      if (forkEnabled) {
        expect(onPromptSuggestions).not.toHaveBeenCalled();
      } else {
        expect(onPromptSuggestions).toHaveBeenCalledExactlyOnceWith(
          ['run the tests'],
          expect.any(String),
        );
      }
    },
  );

  it('finishes the turn without waiting for a background prompt suggestion', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let resolveSuggestion!: (value: null) => void;
    coreMocks.tryGeneratePromptSuggestion.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveSuggestion = resolve;
        }),
    );
    const finishTurn = vi.fn();
    try {
      const { result } = await renderOrchestrator(config, {
        runtimeProjection: { ...NOOP_RUNTIME_PROJECTION, finishTurn },
      });
      await result.current.submitQuery('finish the code change');
      expect(finishTurn).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce(),
      );
    } finally {
      resolveSuggestion?.(null);
    }
  });

  it('does not request prompt suggestions when they are disabled', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config, {
      promptSuggestionEnabled: false,
    });

    await result.current.submitQuery('finish the code change');
    await new Promise((resolve) => setImmediate(resolve));

    expect(coreMocks.tryGeneratePromptSuggestion).not.toHaveBeenCalled();
  });

  it('ignores an in-flight prompt suggestion after the setting is disabled', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    let resolveSuggestion:
      | ((value: { suggestion: string }) => void)
      | undefined;
    coreMocks.tryGeneratePromptSuggestion.mockReturnValue(
      new Promise((resolve) => {
        resolveSuggestion = resolve;
      }),
    );
    const onPromptSuggestions = vi.fn();
    const { mergedSettings, result } = await renderOrchestrator(config, {
      onPromptSuggestions,
    });

    await result.current.submitQuery('finish the code change');
    expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledTimes(1);

    mergedSettings.promptSuggestionEnabled = false;
    resolveSuggestion?.({ suggestion: 'continue with another change' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onPromptSuggestions).not.toHaveBeenCalled();
  });

  it('passes builtin plugin guidance to the TUI prompt suggestion override', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    builtinPluginMocks.promptSuggestionContributions.mockReturnValue([
      { id: 'example', prompt: '## Example plugin guidance' },
    ]);
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('finish the code change');
    await new Promise((resolve) => setImmediate(resolve));

    const suggestionRequest = coreMocks.tryGeneratePromptSuggestion.mock
      .calls[0]?.[0] as { systemPromptOverride?: string } | undefined;
    expect(suggestionRequest?.systemPromptOverride).toContain(
      "You generate optional next-action suggestions for a general local AI agent's TUI",
    );
    expect(suggestionRequest?.systemPromptOverride).toContain(
      '## Example plugin guidance',
    );
  });

  it('skips plugin contributions and the prompt suggestion override in shared mode, then restores them in legacy mode', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    builtinPluginMocks.promptSuggestionContributions.mockReturnValue([
      { id: 'example', prompt: '## Example plugin guidance' },
    ]);
    coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
      enabled: true,
      mode: 'shared',
      forkEnabled: false,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('finish the code change');
    await waitFor(() =>
      expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce(),
    );

    expect(
      builtinPluginMocks.promptSuggestionContributions,
    ).not.toHaveBeenCalled();
    expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ systemPromptOverride: undefined }),
    );

    coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
      enabled: true,
      mode: 'legacy',
      forkEnabled: false,
    });
    await result.current.submitQuery('finish another code change');
    await waitFor(() =>
      expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledTimes(2),
    );

    expect(
      builtinPluginMocks.promptSuggestionContributions,
    ).toHaveBeenCalledOnce();
    expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        systemPromptOverride: expect.stringContaining(
          '## Example plugin guidance',
        ),
      }),
    );
  });

  describe('prompt suggestion feature gate delivery', () => {
    type FeatureConfig = ReturnType<
      typeof coreMocks.getPromptSuggestionFeatureConfig
    >;

    function mockFeatureGateSubscription() {
      let listener:
        | Parameters<typeof coreMocks.subscribePromptSuggestionFeatureGate>[0]
        | undefined;
      const unsubscribe = vi.fn(() => {
        listener = undefined;
      });
      coreMocks.subscribePromptSuggestionFeatureGate.mockImplementation(
        (onChange) => {
          listener = onChange;
          return unsubscribe;
        },
      );
      return {
        notify: (featureConfig: FeatureConfig) => listener?.(featureConfig),
        unsubscribe,
      };
    }

    it.each([
      {
        change: 'disabled',
        configs: [{ enabled: false, mode: 'legacy', forkEnabled: false }],
      },
      {
        change: 'fork only',
        configs: [{ enabled: true, mode: 'legacy', forkEnabled: true }],
      },
      {
        change: 'shared mode',
        configs: [{ enabled: true, mode: 'shared', forkEnabled: false }],
      },
      {
        change: 'shared mode then back to legacy mode',
        configs: [
          { enabled: true, mode: 'shared', forkEnabled: false },
          { enabled: true, mode: 'legacy', forkEnabled: false },
        ],
      },
    ] as const)(
      'aborts an already-resolved prompt suggestion when QCS changes to $change before TUI delivery',
      async ({ configs }) => {
        const { mainRoot } = createDirs();
        const { config } = createConfig({
          directories: [mainRoot],
          targetDir: mainRoot,
        });
        const { notify, unsubscribe } = mockFeatureGateSubscription();
        coreMocks.tryGeneratePromptSuggestion.mockImplementationOnce(() => {
          // The change happens after Core settles but before the TUI resumes.
          const resolved = Promise.resolve({ suggestion: 'run the tests' });
          queueMicrotask(() => {
            for (const featureConfig of configs) {
              coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue(
                featureConfig,
              );
              notify(featureConfig);
            }
          });
          return resolved;
        });
        const onPromptSuggestions = vi.fn();
        const { result } = await renderOrchestrator(config, {
          onPromptSuggestions,
        });

        await result.current.submitQuery('finish the code change');
        await new Promise((resolve) => setImmediate(resolve));

        expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce();
        expect(
          coreMocks.subscribePromptSuggestionFeatureGate,
        ).toHaveBeenCalledOnce();
        expect(onPromptSuggestions).not.toHaveBeenCalled();
        const { signal } = coreMocks.tryGeneratePromptSuggestion.mock
          .calls[0]![0] as { signal: AbortSignal };
        expect(signal.aborted).toBe(true);
        expect(unsubscribe).toHaveBeenCalledOnce();
      },
    );

    it('blocks an already-resolved prompt suggestion when a fresh QCS read changes mode without notification', async () => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const { unsubscribe } = mockFeatureGateSubscription();
      coreMocks.tryGeneratePromptSuggestion.mockImplementationOnce(() => {
        const resolved = Promise.resolve({ suggestion: 'run the tests' });
        queueMicrotask(() => {
          coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
            enabled: true,
            mode: 'shared',
            forkEnabled: false,
          });
        });
        return resolved;
      });
      const onPromptSuggestions = vi.fn();
      const { result } = await renderOrchestrator(config, {
        onPromptSuggestions,
      });

      await result.current.submitQuery('finish the code change');
      await new Promise((resolve) => setImmediate(resolve));

      expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce();
      expect(
        coreMocks.subscribePromptSuggestionFeatureGate,
      ).toHaveBeenCalledOnce();
      expect(onPromptSuggestions).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it.each(['legacy', 'shared'] as const)(
      'delivers a prompt suggestion after a same-mode QCS hot update in %s mode and unsubscribes after the callback',
      async (mode) => {
        const { mainRoot } = createDirs();
        const { config } = createConfig({
          directories: [mainRoot],
          targetDir: mainRoot,
        });
        coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
          enabled: true,
          mode,
          forkEnabled: false,
        });
        const { notify, unsubscribe } = mockFeatureGateSubscription();
        coreMocks.tryGeneratePromptSuggestion.mockImplementationOnce(() => {
          const resolved = Promise.resolve({ suggestion: 'run the tests' });
          queueMicrotask(() => {
            const featureConfig = { enabled: true, mode, forkEnabled: false };
            coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue(
              featureConfig,
            );
            notify(featureConfig);
          });
          return resolved;
        });
        const onPromptSuggestions = vi.fn(() => unsubscribe.mock.calls.length);
        const { result } = await renderOrchestrator(config, {
          onPromptSuggestions,
        });

        await result.current.submitQuery('finish the code change');
        await new Promise((resolve) => setImmediate(resolve));

        expect(coreMocks.tryGeneratePromptSuggestion).toHaveBeenCalledOnce();
        expect(
          coreMocks.subscribePromptSuggestionFeatureGate,
        ).toHaveBeenCalledOnce();
        expect(onPromptSuggestions).toHaveReturnedWith(0);
        expect(onPromptSuggestions).toHaveBeenCalledExactlyOnceWith(
          ['run the tests'],
          expect.any(String),
        );
        const { signal } = coreMocks.tryGeneratePromptSuggestion.mock
          .calls[0]![0] as { signal: AbortSignal };
        expect(signal.aborted).toBe(false);
        expect(unsubscribe).toHaveBeenCalledOnce();
      },
    );

    it.each(['legacy', 'shared'] as const)(
      'does not generate a prompt suggestion when QCS is initially disabled in %s mode',
      async (mode) => {
        const { mainRoot } = createDirs();
        const { config } = createConfig({
          directories: [mainRoot],
          targetDir: mainRoot,
        });
        coreMocks.getPromptSuggestionFeatureConfig.mockReturnValue({
          enabled: false,
          mode,
          forkEnabled: false,
        });
        coreMocks.tryGeneratePromptSuggestion.mockResolvedValue({
          suggestion: 'run the tests',
        });
        const onPromptSuggestions = vi.fn();
        const { result } = await renderOrchestrator(config, {
          onPromptSuggestions,
        });

        await result.current.submitQuery('finish the code change');
        await new Promise((resolve) => setImmediate(resolve));

        expect(coreMocks.tryGeneratePromptSuggestion).not.toHaveBeenCalled();
        expect(
          coreMocks.subscribePromptSuggestionFeatureGate,
        ).not.toHaveBeenCalled();
        expect(
          builtinPluginMocks.promptSuggestionContributions,
        ).not.toHaveBeenCalled();
        expect(onPromptSuggestions).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    {
      code: 'insufficient_quota',
      status: 429,
      kind: 'quota_exhausted' as const,
      expected: 'check your provider usage and limits',
    },
    {
      code: undefined,
      status: 503,
      kind: 'server' as const,
      expected: 'temporarily unavailable',
    },
    {
      code: undefined,
      status: 408,
      kind: 'server' as const,
      expected: 'did not respond in time',
    },
  ])(
    'restores the current-turn $status message for $code',
    async ({ code, status, kind, expected }) => {
      const { ModelInferenceError } = await import(
        '../../../../core/src/provider/modelInferenceError.js'
      );
      const failure = new ModelInferenceError('private provider diagnostic', {
        code,
        status,
        kind,
        phase: 'before_output',
      });
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      vi.mocked(query).mockImplementation(async function* () {
        yield { type: 'request_start' };
        return { reason: 'error', error: failure };
      } as never);
      const addItem = vi.fn();
      const { result } = await renderOrchestrator(config, { addItem });
      await result.current.submitQuery('hello');
      const errors = addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.ERROR,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0][0].text).toContain(expected);
      expect(failure.code).toBe(code);
    },
  );

  it.each([
    { code: '112', provider: true },
    { code: '140', provider: true },
    { code: 'EXTERNAL_TOKEN_RATE_LIMITED', provider: true },
    { code: undefined, provider: true },
    { code: 'max_output_tokens', provider: false },
    { code: 406, provider: false },
  ])(
    'selects TUI text for Provider/local code $code at the host boundary',
    async ({ code, provider }) => {
      const { ModelInferenceError } = await import(
        '../../../../core/src/provider/modelInferenceError.js'
      );
      const failure = provider
        ? new ModelInferenceError('Provider diagnostic', {
            code: code === undefined ? undefined : String(code),
            kind: 'invalid_request',
            status: 403,
            phase: 'before_output',
          })
        : Object.assign(new Error('Provider diagnostic'), { code });
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      vi.mocked(query).mockImplementation(async function* () {
        const { createAssistantAPIErrorMessage } = await import(
          '../../../../core/src/protocol/transcript/conversions.js'
        );
        yield createAssistantAPIErrorMessage({
          content: failure.message,
          displayErrorCode: code,
        });
        return { reason: 'error', error: failure };
      } as never);
      const addItem = vi.fn();
      const { result } = await renderOrchestrator(config, { addItem });
      await result.current.submitQuery('hello');
      expect(formatApiErrorDisplayMessage).toHaveBeenCalledWith(
        provider ? undefined : code,
        expect.any(String),
      );
      const errors = addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.ERROR,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0][0].text).not.toContain('Provider diagnostic');
    },
  );

  it.each([
    { code: '401', status: 401, providerSource: 'custom-provider', expectedCode: undefined },
    {
      code: 'invalid_api_key',
      status: undefined,
      providerSource: 'custom-provider',
      expectedCode: undefined,
    },
    { code: '403', status: 403, providerSource: 'custom-provider', expectedCode: undefined },
    { code: '401', status: 401, providerSource: 'qoder', expectedCode: '401' },
  ])(
    'renders current-turn auth error $code (provider=$providerSource)',
    async ({ code, status, providerSource, expectedCode }) => {
      const { ModelInferenceError } = await import(
        '../../../../core/src/provider/modelInferenceError.js'
      );
      const { createAssistantAPIErrorMessage } = await import(
        '../../../../core/src/protocol/transcript/conversions.js'
      );
      const failure = new ModelInferenceError('private provider diagnostic', {
        code,
        status,
        kind: 'auth',
        phase: 'before_output',
      });
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      vi.mocked(query).mockImplementation(async function* () {
        yield createAssistantAPIErrorMessage({
          content: failure.message,
          displayErrorCode: code,
          modelError: { kind: 'auth', status, providerSource },
        });
        return { reason: 'error', error: failure };
      } as never);
      const addItem = vi.fn();
      const { result } = await renderOrchestrator(config, { addItem });
      await result.current.submitQuery('hello');
      expect(formatApiErrorDisplayMessage).toHaveBeenLastCalledWith(
        expectedCode,
        expect.any(String),
      );
      expect(failure.code).toBe(code);
      const errors = addItem.mock.calls.filter(
        ([item]) => item.type === MessageType.ERROR,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0][0].text).not.toContain('private provider diagnostic');
      if (providerSource === 'custom-provider' && code === '401') {
        // A later failure without source metadata must not use product text.
        vi.mocked(query).mockImplementation(async function* () {
          yield { type: 'request_start' };
          return { reason: 'error', error: failure };
        } as never);
        await result.current.submitQuery('next turn');
        expect(formatApiErrorDisplayMessage).toHaveBeenLastCalledWith(
          undefined,
          expect.stringContaining('credentials'),
        );
      }
    },
  );

  it.each([
    { providerSource: 'qoder', kind: 'quota_exhausted', expected: 'Billing Group' },
    { providerSource: 'custom-provider', kind: 'auth', expected: 'permissions' },
    { providerSource: 'qwen-subscription', kind: 'auth', expected: 'permissions' },
    { providerSource: undefined, kind: 'auth', expected: 'permissions' },
  ] as const)(
    'scopes live HTTP 403/code 122 text to its provider (provider=$providerSource)',
    async ({ providerSource, kind, expected }) => {
      const { ModelInferenceError } = await import(
        '../../../../core/src/provider/modelInferenceError.js'
      );
      const { createAssistantAPIErrorMessage } = await import(
        '../../../../core/src/protocol/transcript/conversions.js'
      );
      const failure = new ModelInferenceError('Provider diagnostic', {
        code: '122',
        status: 403,
        kind,
        phase: 'before_output',
      });
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      vi.mocked(query).mockImplementation(async function* () {
        yield createAssistantAPIErrorMessage({
          content: failure.message,
          displayErrorCode: failure.code,
          modelError: { kind, status: 403, providerSource },
        });
        return { reason: 'error', error: failure };
      } as never);
      const addItem = vi.fn();
      const { result } = await renderOrchestrator(config, { addItem });
      await result.current.submitQuery('hello');

      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining(expected),
        }),
        expect.any(Number),
        true,
      );
    },
  );

  it('does not render synthetic API error assistant messages', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const rawApiError =
      'Qoder API error: FORBIDDEN - {"code":"122","message":"{}"}';
    const displayMessage = 'Billing Group Credits exhausted';
    vi.mocked(formatApiErrorDisplayMessage).mockReturnValueOnce(displayMessage);
    vi.mocked(query).mockImplementation(async function* () {
      yield {
        type: 'assistant',
        uuid: 'api-error-message',
        timestamp: '2026-06-27T00:00:00.000Z',
        message: {
          id: 'msg_api_error',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: '<synthetic>',
          content: [{ type: 'text', text: rawApiError }],
          stop_reason: null,
        },
        isApiErrorMessage: true,
      } as Message;
      return {
        reason: 'error',
        error: new Error(rawApiError),
      };
    } as never);
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      handleAssistantMessage: vi.fn(),
    };
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, {
      addItem,
      runtimeProjection,
    });

    await result.current.submitQuery('hello');

    expect(runtimeProjection.handleAssistantMessage).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: displayMessage,
      }),
      expect.any(Number),
      true,
    );
    const renderedError = addItem.mock.calls.find(
      ([item]) => item.type === MessageType.ERROR,
    )?.[0];
    expect(renderedError).not.toHaveProperty('excludedFromContext');
    expect(formatApiErrorDisplayMessage).toHaveBeenCalledWith(
      '122',
      expect.any(String),
    );
  });

  it('max output tokens preserves partial text and displays one terminal error', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const displayMessage =
      'The response is incomplete. Split the task and retry.';
    vi.mocked(formatApiErrorDisplayMessage).mockReturnValueOnce(displayMessage);
    vi.mocked(query).mockImplementation(async function* () {
      yield {
        type: 'assistant',
        uuid: 'partial-output',
        timestamp: '2026-10-13T00:00:00.000Z',
        message: {
          id: 'partial-output',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: 'test-model',
          content: [{ type: 'text', text: 'Partial response' }],
          stop_reason: 'max_tokens',
        },
      } as Message;
      yield {
        type: 'assistant',
        uuid: 'max-output-error',
        timestamp: '2026-10-13T00:00:00.000Z',
        message: {
          id: 'max-output-error',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: '<synthetic>',
          content: [{ type: 'text', text: displayMessage }],
          stop_reason: null,
        },
        isApiErrorMessage: true,
        displayErrorCode: 'max_output_tokens',
        errorFallbackMessage: displayMessage,
      } as Message;
      return {
        reason: 'error',
        modelStopReason: 'max_tokens',
        error: Object.assign(new Error(displayMessage), {
          code: 'max_output_tokens',
          error_code: 'max_output_tokens',
        }),
      };
    } as never);
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      handleAssistantMessage: vi.fn(),
    };
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, {
      addItem,
      runtimeProjection,
    });
    await result.current.submitQuery('Original prompt');
    expect(
      runtimeProjection.handleAssistantMessage,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: [{ type: 'text', text: 'Partial response' }],
      }),
    );
    expect(
      addItem.mock.calls
        .filter(([item]) => item.type === MessageType.ERROR)
        .map(([item]) => item.text),
    ).toEqual([displayMessage]);
  });

  it('preserves partial text and renders refusal as one error item', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const dynamicMessage = 'Dynamic 406 content-filtered message';
    vi.mocked(formatApiErrorDisplayMessage).mockReturnValueOnce(dynamicMessage);
    vi.mocked(query).mockImplementation(async function* () {
      yield {
        type: 'assistant',
        uuid: 'partial-refusal-message',
        timestamp: '2026-07-20T00:00:00.000Z',
        message: {
          id: 'partial-refusal-message',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: 'test-model',
          content: [{ type: 'text', text: 'Partial response' }],
          stop_reason: 'refusal',
        },
      } as Message;
      yield {
        type: 'assistant',
        uuid: 'content-filtered-message',
        timestamp: '2026-07-20T00:00:00.000Z',
        message: {
          id: 'content-filtered-message',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,
          model: '<synthetic>',
          content: [{ type: 'text', text: dynamicMessage }],
          stop_reason: null,
        },
        isApiErrorMessage: true,
        isContentFilteredMessage: true,
        displayErrorCode: 406,
        errorFallbackMessage: 'Session blocked',
      } as Message;
      return {
        reason: 'error',
        modelStopReason: 'refusal',
        error: Object.assign(new Error(dynamicMessage), {
          code: 'MODEL_REFUSAL',
          error_code: 'MODEL_REFUSAL',
          status: 406,
        }),
      };
    } as never);
    const runtimeProjection: RuntimeProjectionController = {
      ...NOOP_RUNTIME_PROJECTION,
      handleAssistantMessage: vi.fn(),
    };
    const addItem = vi.fn();
    const { result } = await renderOrchestrator(config, {
      addItem,
      runtimeProjection,
    });

    await result.current.submitQuery('hello');

    expect(runtimeProjection.handleAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'Partial response' }],
      }),
    );
    expect(addItem).toHaveBeenCalledWith(
      {
        type: MessageType.ERROR,
        text: dynamicMessage,
        excludedFromContext: true,
      },
      expect.any(Number),
      true,
    );
    expect(
      addItem.mock.calls.filter(
        ([item]) =>
          item.type === MessageType.ERROR && item.text === dynamicMessage,
      ),
    ).toHaveLength(1);
  });

  it('reuses repeated tool call allowlist across direct TUI queries', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const queryOptions: Array<{
      prompt?: string;
      repeatedToolCallAllowedKeys?: Set<string>;
    }> = [];
    vi.mocked(query).mockImplementation(async function* (options: {
      prompt?: string;
      repeatedToolCallAllowedKeys?: Set<string>;
    }) {
      queryOptions.push(options);
      // Preserve the async-generator query mock shape while satisfying require-yield.
      yield* [];
      return { reason: 'end_turn' };
    } as never);
    vi.mocked(executeUserInput).mockResolvedValue({
      messages: [],
      shouldQuery: false,
    });
    const { result, unmount } = await renderOrchestrator(config);

    await result.current.submitQuery('first prompt');
    await Promise.resolve();
    const firstQueryOptions = queryOptions.filter(
      (options) => options.repeatedToolCallAllowedKeys instanceof Set,
    )[0];
    const firstAllowlist = firstQueryOptions?.repeatedToolCallAllowedKeys;
    expect(firstAllowlist).toBeInstanceOf(Set);
    firstAllowlist!.add('Read:{"file_path":"/tmp/same.txt"}');

    await result.current.submitQuery('second prompt');
    await Promise.resolve();
    const secondQueryOptions = queryOptions.filter(
      (options) => options.repeatedToolCallAllowedKeys instanceof Set,
    )[1];
    const secondAllowlist = secondQueryOptions?.repeatedToolCallAllowedKeys;

    expect(secondAllowlist).toBe(firstAllowlist);
    expect(secondAllowlist!.has('Read:{"file_path":"/tmp/same.txt"}')).toBe(
      true,
    );

    await result.current.replaceMessages(
      [] as Message[],
      config.getSessionId(),
      {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      },
    );
    await result.current.submitQuery('third prompt');
    await Promise.resolve();
    const thirdQueryOptions = queryOptions.filter(
      (options) => options.repeatedToolCallAllowedKeys instanceof Set,
    )[2];
    const thirdAllowlist = thirdQueryOptions?.repeatedToolCallAllowedKeys;

    expect(thirdAllowlist).toBe(firstAllowlist);
    expect(thirdAllowlist!.has('Read:{"file_path":"/tmp/same.txt"}')).toBe(
      false,
    );

    unmount();
  });

  it.each([undefined, 'low'] as const)(
    'TUI 默认模型不作为覆盖传递，单次 effort=%s',
    async (effort) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      vi.mocked(executeUserInput).mockResolvedValueOnce({
        messages: [],
        shouldQuery: true,
        effort,
      });
      const { result, unmount } = await renderOrchestrator(config);
      try {
        await result.current.submitQuery('/skill', { useInputProcessor: true });
        expect(query).toHaveBeenCalledOnce();
        expect(vi.mocked(query).mock.calls[0]![0]).not.toHaveProperty('modelOverride');
        expect(vi.mocked(query).mock.calls[0]![0].querySelection).toEqual(
          effort === undefined
            ? undefined
            : { key: undefined, config: { reasoning: { effort } } },
        );
      } finally {
        unmount();
      }
    },
  );

  it('TUI frontmatter 模型与 effort 延后兑换，目录缺失不提前阻断查询', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const getModel = vi
      .mocked(config.getModelProviderManager().getModel)
      .mockResolvedValue(undefined);
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [],
      shouldQuery: true,
      model: 'not-yet-listed',
      effort: 'low',
    });
    const { result, unmount } = await renderOrchestrator(config);
    try {
      await result.current.submitQuery('/skill', { useInputProcessor: true });
      expect(executeUserInput).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(vi.mocked(query).mock.calls[0]![0]).not.toHaveProperty('modelOverride');
      expect(vi.mocked(query).mock.calls[0]![0]).toMatchObject({
        querySelection: {
          key: 'not-yet-listed',
          config: { reasoning: { effort: 'low' } },
        },
      });
      expect(getModel).not.toHaveBeenCalledWith('not-yet-listed');
    } finally {
      unmount();
    }
  });

  it('leaves model-default context windows in Config for query selection', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.submitQuery('use the configured context window');
    expect(config.getEffectiveContextWindow).not.toHaveBeenCalled();
    expect(vi.mocked(query).mock.calls[0]?.[0]).not.toHaveProperty(
      'contextWindow',
    );
  });

  it('recounts the complete resumed request with current prompt, tools and memory prefix', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result, unmount } = await renderHook(() =>
      useLocalTuiSessionOrchestrator({
        config,
        addItem: vi.fn(),
        focusMachine: null,
        getPreferredEditor: () => undefined,
        onCancelSubmit: vi.fn(),
        initialConversationHistory: undefined,
        runtimeProjectionRef: { current: NOOP_RUNTIME_PROJECTION },
        settings: {
          merged: {
            security: { auth: { selectedType: AuthType.QODER_BROWSER } },
          },
        } as unknown as LoadedSettings,
        version: 'test-version',
      }),
    );
    const summary = {
      type: 'user',
      uuid: 'summary',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'resumed compact summary' },
    } as Message;
    const prefix = {
      ...summary,
      uuid: 'prefix',
      message: { blocks: 'startup memory' },
    } as Message;
    result.current.setMessages(() => [summary]);
    vi.mocked(createTurnPromptResolver).mockResolvedValueOnce(
      async () =>
        ({
          blocks: [{ type: 'text', text: 'restored system prompt' }],
        }) as never,
    );
    vi.mocked(buildStartupMemoryPrefix).mockReturnValueOnce([prefix]);
    vi.mocked(countRequestTokens).mockReturnValueOnce({
      tokens: 52003,
      source: 'estimate',
    });
    await result.current.refreshContextTokenCount();
    expect(countRequestTokens).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'test-model',
        messages: [prefix, summary],
        systemPrompt: [{ type: 'text', text: 'restored system prompt' }],
        tools: expect.any(Array),
      }),
    );
    expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenLastCalledWith(
      52003,
    );
    unmount();
  });

  it.each(['manual', 'auto'] as const)(
    'refreshes the btw snapshot after %s compact without mutating in-flight forks',
    async (trigger) => {
      const { mainRoot } = createDirs();
      const { config } = createConfig({
        directories: [mainRoot],
        targetDir: mainRoot,
      });
      const message = (uuid: string): Message => ({
        type: 'user',
        uuid,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: uuid },
      });
      const prefix = message('startup-prefix');
      const oldHistory = message('old-history');
      const summary = message('compact-summary');
      const recovery = message('recovery-attachment');
      const environment = (workingDirectory: string) =>
        createAttachmentMessage(
          new EnvironmentAttachment({
            type: 'environment',
            snapshot: {
              workingDirectory,
              isWorktree: false,
              isGitRepo: true,
              additionalWorkingDirectories: [],
              platform: 'linux',
              shell: 'bash',
              osVersion: 'test',
              architecture: 'x64',
              nodeVersion: 'test',
            },
          }),
        );
      const sessionContext = (gitStatus: string) =>
        createAttachmentMessage(
          new SessionContextAttachment({
            type: 'session_context',
            context: { gitStatus },
          }),
        );
      const oldContext = [environment('/old'), sessionContext('old branch')];
      const newEnvironment = environment('/new');
      const newSessionContext = sessionContext('new branch');
      const snapshot = {
        model: 'test-model',
        modelResolution: testModelResolution('test-model'),
        systemPrompt: [{ type: 'text', text: 'parent system' }],
        toolSchemas: [{ name: 'Read' }],
        requestPrefixMessages: [prefix],
        forkContextMessages: [oldHistory],
        contextAttachmentMessages: oldContext,
        contextWindow: 200_000,
        lastAssistantUsage: { input_tokens: 157_000 },
      };
      let compressAutomatically: (
        prior: Message[],
        next: Message[],
      ) => Promise<readonly Message[]>;
      vi.mocked(query).mockImplementation(async function* (options: {
        onCacheSafeSnapshot: (value: unknown) => void;
        onCompressionCompleted: typeof compressAutomatically;
      }) {
        options.onCacheSafeSnapshot(snapshot);
        compressAutomatically = options.onCompressionCompleted;
        yield* [];
        return { reason: 'end_turn' };
      } as never);
      const { result, unmount } = await renderHook(() =>
        useLocalTuiSessionOrchestrator({
          config,
          addItem: vi.fn(),
          focusMachine: null,
          getPreferredEditor: () => undefined,
          onCancelSubmit: vi.fn(),
          runtimeProjectionRef: { current: NOOP_RUNTIME_PROJECTION },
          settings: {
            merged: {
              security: { auth: { selectedType: AuthType.QODER_BROWSER } },
            },
          } as LoadedSettings,
          version: 'test-version',
        }),
      );
      await result.current.submitQuery('prime snapshot');
      const accessors = vi
        .mocked(config.registerForkContextAccessors)
        .mock.calls.map(([value]) => value)
        .findLast((value) => value !== undefined)!;
      expect(accessors.getCacheSafeQuerySnapshot!()).toBe(snapshot);
      vi.mocked(applyPostCompact).mockImplementationOnce(
        async (_prior, next, callbacks) => {
          callbacks.replaceMessages([...next]);
          // Even while recovery/persistence is pending, /btw must see the summary.
          expect(accessors.getCacheSafeQuerySnapshot!()).toMatchObject({
            forkContextMessages: [prefix, summary, newEnvironment],
            contextAttachmentMessages: [newEnvironment],
            lastAssistantUsage: undefined,
          });
          callbacks.pushAttachments([recovery, newSessionContext]);
          return [...next, recovery, newSessionContext];
        },
      );
      if (trigger === 'manual') {
        coreMocks.compressionPipelineInstances
          .at(-1)!
          .compress.mockResolvedValueOnce({
            newHistory: [summary, newEnvironment],
            info: { compressionStatus: 'compressed' },
          });
        await result.current.runManualCompress();
      } else {
        await compressAutomatically!([oldHistory], [summary, newEnvironment]);
      }
      const refreshed = accessors.getCacheSafeQuerySnapshot!();
      expect(refreshed).toEqual({
        ...snapshot,
        forkContextMessages: [
          prefix,
          summary,
          newEnvironment,
          recovery,
          newSessionContext,
        ],
        contextAttachmentMessages: [newEnvironment, newSessionContext],
        lastAssistantUsage: undefined,
      });
      expect(refreshed).not.toBe(snapshot);
      expect(snapshot.forkContextMessages).toEqual([oldHistory]);
      expect(snapshot.contextAttachmentMessages).toBe(oldContext);
      expect(snapshot.lastAssistantUsage.input_tokens).toBe(157_000);
      unmount();
    },
  );

  it('builds TUI manual compact from the current context instead of the parent snapshot', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(query).mockImplementation(async function* (options: {
      onCacheSafeSnapshot?: (snapshot: unknown) => void;
    }) {
      options.onCacheSafeSnapshot?.({
        forkContextMessages: [],
        model: 'routed-parent-model',
        toolSchemas: [],
        reasoningEffort: 'low',
        contextWindow: 128_000,
      });
      yield* [];
      return { reason: 'end_turn' };
    } as never);
    const { result } = await renderOrchestrator(config);
    await result.current.submitQuery('prime compact snapshot');

    const select = vi.spyOn(modelManager, 'select');
    select
      .mockResolvedValueOnce(
        testModelResolution('test-model', {
          contextWindow: 128_000,
        }),
      )
      .mockResolvedValue(
        testModelResolution('routed-compact-model', {
          reasoningEffort: 'high',
          contextWindow: 256_000,
        }),
      );
    let resolvedCompactRequest: unknown;
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockImplementation(
      async (_history: unknown, options: CompressOptions) => {
        expect(options.modelResolution.model.key).toBe('test-model');
        expect(options.systemPrompt).toEqual([]);
        expect(options.tools).toBeDefined();
        resolvedCompactRequest = await options.resolveCompactSelection!();
        return {
          newHistory: null,
          info: {
            originalTokenCount: 1,
            newTokenCount: 1,
            compressionStatus: 'noop',
          },
        };
      },
    );

    await result.current.runManualCompress();

    expect(select.mock.calls[0]![0]).toMatchObject({
      purpose: 'main',
      parentSelection: undefined,
      overrideSelection: undefined,
    });
    expect(config.getEffectiveContextWindow).not.toHaveBeenCalled();
    expect(modelManager.getModelConfig).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'compact',
        parentSelection: expect.objectContaining({
          model: expect.objectContaining({ key: 'test-model' }),
          config: expect.objectContaining({
            context: { contextWindow: 128_000 },
          }),
        }),
      }),
    );
    expect(resolvedCompactRequest).toMatchObject({
      selection: {
        model: { key: 'routed-compact-model' },
        config: {
          reasoning: { effort: 'high' },
          context: { contextWindow: 256_000 },
        },
      },
    });
    expect(pipeline.options.modelProviderManager).toBe(
      config.getModelProviderManager(),
    );
    const compactOptions = pipeline.compress.mock.calls[0]![1];
    for (const key of [
      'model',
      'generation',
      'thinkingBudget',
      'reasoningEffort',
      'contextWindow',
      'resolveCompactRequest',
    ]) {
      expect(compactOptions).not.toHaveProperty(key);
    }
  });

  it('ignores the parent snapshot after the configured model changes', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(query).mockImplementation(async function* (options: {
      onCacheSafeSnapshot?: (snapshot: unknown) => void;
    }) {
      options.onCacheSafeSnapshot?.({
        forkContextMessages: [],
        model: 'routed-parent-model',
        systemPrompt: 'parent system prompt',
        toolSchemas: [],
        thinkingBudget: 512,
        reasoningEffort: 'low',
        contextWindow: 128_000,
      });
      yield* [];
      return { reason: 'end_turn' };
    } as never);
    const { result } = await renderOrchestrator(config);
    await result.current.submitQuery('prime compact snapshot');

    vi.mocked(config.getModel).mockReturnValue('switched-model');
    vi.mocked(config.getModelProviderManager().getModelConfig).mockReturnValue({
      reasoning: { effort: 'high' },
    });
    vi.mocked(config.getEffectiveContextWindow).mockReturnValue(256_000);

    const select = vi.spyOn(modelManager, 'select');
    select.mockImplementation(async (input) => {
      if (input.purpose === 'compact') throw new Error('policy unavailable');
      return testModelResolution(config.getModel(), {
        reasoningEffort: 'high',
        contextWindow: 256_000,
      });
    });
    let resolvedCompactRequest: unknown;
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockImplementation(
      async (_history: unknown, options: CompressOptions) => {
        expect(options.modelResolution).toMatchObject({
          model: { key: 'switched-model' },
          config: {
            reasoning: { effort: 'high' },
            context: { contextWindow: 256_000 },
          },
        });
        expect(options.systemPrompt).not.toBe('parent system prompt');
        expect(
          options.modelResolution.config.reasoning?.thinking,
        ).toBeUndefined();
        resolvedCompactRequest = await options.resolveCompactSelection!();
        return {
          newHistory: null,
          info: {
            originalTokenCount: 1,
            newTokenCount: 1,
            compressionStatus: 'noop',
          },
        };
      },
    );

    await result.current.runManualCompress();

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'compact',
        parentSelection: expect.objectContaining({
          model: expect.objectContaining({ key: 'switched-model' }),
          config: {
            reasoning: { effort: 'high' },
            context: { contextWindow: 256_000 },
          },
        }),
      }),
    );
    expect(resolvedCompactRequest).toMatchObject({
      selection: {
        model: { key: 'switched-model' },
        config: {
          reasoning: { effort: 'high' },
          context: { contextWindow: 256_000 },
        },
      },
      source: 'current',
    });
  });

  it('falls back to the current context when TUI manual compact routing fails', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    vi.mocked(query).mockImplementation(async function* (options: {
      onCacheSafeSnapshot?: (snapshot: unknown) => void;
    }) {
      options.onCacheSafeSnapshot?.({
        forkContextMessages: [],
        model: 'routed-parent-model',
        toolSchemas: [],
        reasoningEffort: 'low',
        contextWindow: 128_000,
      });
      yield* [];
      return { reason: 'end_turn' };
    } as never);
    const { result } = await renderOrchestrator(config);
    await result.current.submitQuery('prime compact snapshot');

    const select = vi.spyOn(modelManager, 'select');
    select.mockImplementation(async (input) => {
      if (input.purpose === 'compact') throw new Error('policy unavailable');
      return testModelResolution(config.getModel(), { contextWindow: 128_000 });
    });
    let resolvedCompactRequest: unknown;
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockImplementation(
      async (_history: unknown, options: CompressOptions) => {
        expect(options.modelResolution.model.key).toBe('test-model');
        resolvedCompactRequest = await options.resolveCompactSelection!();
        return {
          newHistory: null,
          info: {
            originalTokenCount: 1,
            newTokenCount: 1,
            compressionStatus: 'noop',
          },
        };
      },
    );

    await result.current.runManualCompress();

    expect(select).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'compact',
        parentSelection: expect.objectContaining({
          model: expect.objectContaining({ key: 'test-model' }),
          config: expect.objectContaining({
            context: { contextWindow: 128_000 },
          }),
        }),
      }),
    );
    expect(resolvedCompactRequest).toMatchObject({
      selection: {
        model: { key: 'test-model' },
        config: { context: { contextWindow: 128_000 } },
      },
      source: 'current',
    });
  });

  it('preserves prepareParent 404 recovery and SDK labels through the compact selection adapter', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const manager = config.getModelProviderManager();
    modelManager.select.mockRejectedValueOnce(
      new ModelNotFoundError('Session model unavailable', 404),
    );
    const labels = { taskId: 'compact-policy', subTask: 'recovered-parent' };
    const policy = vi.fn(async () => ({ model: 'recovered-model', labels }));
    Object.assign(config, { getModelPolicy: policy });
    const { result } = await renderOrchestrator(config);
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockImplementation(
      async (_history, options: CompressOptions) => {
        expect(options.modelResolution.model.key).toBe('recovered-model');
        const resolved = await options.resolveCompactSelection!();
        expect(resolved.selection).toBe(options.modelResolution);
        expect(resolved.policyLabels).toEqual(labels);
        expect(resolved.source).toBe('sdk-policy');
        return { newHistory: null, info: { compressionStatus: 'noop' } };
      },
    );

    await result.current.runManualCompress();

    expect(policy).toHaveBeenCalledOnce();
    expect(pipeline.options.modelProviderManager).toBe(manager);
  });

  it('TUI manual compact 的 NOOP 不提前调用 SDK 策略', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    const host = vi.fn(async () => {
      throw new Error('NOOP 不应调用宿主');
    });
    Object.assign(config, { getModelPolicy: host });
    const select = vi.spyOn(modelManager, 'select');
    select.mockImplementation((input) =>
      fixedSelection(config.getModel()).resolve(input),
    );
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockResolvedValue({
      newHistory: null,
      info: {
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: 'noop',
      },
    });
    await result.current.runManualCompress();
    expect(select.mock.calls.map(([input]) => input.purpose)).toEqual(['main']);
    expect(host).not.toHaveBeenCalled();
  });

  it('rethrows TUI manual compact routing cancellation', async () => {
    const { mainRoot } = createDirs();
    const { config, modelManager } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    const cancellationError = new Error('Operation cancelled by user');
    const select = vi.spyOn(modelManager, 'select');
    select.mockImplementation(async (input) => {
      if (input.purpose === 'compact') throw cancellationError;
      return fixedSelection(config.getModel()).resolve(input);
    });
    const pipeline = coreMocks.compressionPipelineInstances.at(-1)!;
    pipeline.compress.mockImplementation(
      async (_history: unknown, options: CompressOptions) => {
        await options.resolveCompactSelection!();
        throw new Error('unreachable');
      },
    );

    await expect(result.current.runManualCompress()).rejects.toBe(
      cancellationError,
    );
  });

  it('preallocates one requestSetId shared by the turn query and its business info', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.submitQuery('trace this query');

    const queryOptions = vi.mocked(query).mock.calls[0]?.[0] as
      | {
          preallocatedRequestSetId?: string;
          businessInfo?: { id: string };
        }
      | undefined;

    expect(queryOptions?.preallocatedRequestSetId).toEqual(expect.any(String));
    // 计量与请求集锚在同一次 turn 上：businessInfo.id 就是预分配的 requestSetId。
    expect(queryOptions?.businessInfo?.id).toBe(
      queryOptions?.preallocatedRequestSetId,
    );
  });

  it('generates distinct user message UUIDs for separate TUI owners of the same resumed session', async () => {
    const { mainRoot } = createDirs();
    const firstConfig = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    }).config;
    const secondConfig = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    }).config;
    const existingMessages = [
      {
        type: 'user',
        uuid: 'user:current-session########2',
        timestamp: '2026-07-16T00:00:00.000Z',
        message: {
          role: 'user',
          content: 'existing prompt',
        },
      },
    ] as Message[];
    const first = await renderOrchestrator(firstConfig);
    const second = await renderOrchestrator(secondConfig);

    await first.result.current.replaceMessages(
      existingMessages,
      'current-session',
      {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      },
    );
    await second.result.current.replaceMessages(
      existingMessages,
      'current-session',
      {
        restoreExistingSession: true,
        transcriptProjectRoot: mainRoot,
      },
    );
    const [firstFileHistoryManager, secondFileHistoryManager] =
      coreMocks.fileHistoryManagerInstances.slice(-2);
    await first.result.current.submitQuery('first concurrent prompt');
    await second.result.current.submitQuery('second concurrent prompt');

    const firstUserMessage = vi.mocked(query).mock.calls[0]?.[0]?.userMessage;
    const secondUserMessage = vi.mocked(query).mock.calls[1]?.[0]?.userMessage;

    expect(firstUserMessage?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondUserMessage?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondUserMessage?.uuid).not.toBe(firstUserMessage?.uuid);
    expect(firstFileHistoryManager?.makeSnapshot).toHaveBeenCalledWith(
      firstUserMessage?.uuid,
    );
    expect(secondFileHistoryManager?.makeSnapshot).toHaveBeenCalledWith(
      secondUserMessage?.uuid,
    );
  });

  it('preserves local session input metadata through the original user input entry', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);
    await result.current.replaceMessages([], 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    const listed = testModelResolution('test-model').model;
    vi.mocked(config.getModelProviderManager().getModel).mockResolvedValue({
      ...listed,
      capabilities: { ...listed.capabilities, vision: true },
    });
    const contentBlocks = [
      { type: 'text' as const, text: 'provided local input' },
    ];
    const userMessage = {
      uuid: 'local-session-original',
      timestamp: '2026-11-02T12:00:00Z',
    };
    vi.mocked(executeUserInput).mockResolvedValueOnce({
      messages: [
        {
          type: 'user',
          uuid: userMessage.uuid,
          message: { role: 'user', content: 'provided local input' },
        } as Message,
      ],
      shouldQuery: true,
    });
    await result.current.submitUserInput('provided local input', {
      contentBlocks,
      userMessage,
      hideFromDisplay: true,
    });
    expect(executeUserInput).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          uuid: userMessage.uuid,
          prompt: contentBlocks,
        }),
      ],
      expect.any(Object),
    );
    expect(vi.mocked(query).mock.calls[0]?.[0]?.userMessage).toEqual(
      expect.objectContaining(userMessage),
    );
    expect(
      coreMocks.fileHistoryManagerInstances.at(-1)?.makeSnapshot,
    ).toHaveBeenCalledWith(userMessage.uuid);
  });

  it('preserves a caller-provided user message UUID across query and file history', async () => {
    const { mainRoot } = createDirs();
    const { config } = createConfig({
      directories: [mainRoot],
      targetDir: mainRoot,
    });
    const { result } = await renderOrchestrator(config);

    await result.current.replaceMessages([], 'current-session', {
      restoreExistingSession: true,
      transcriptProjectRoot: mainRoot,
    });
    await result.current.submitQuery('provided identity', {
      userMessage: {
        uuid: 'provided-user-message-id',
      },
    });

    expect(vi.mocked(query).mock.calls[0]?.[0]?.userMessage?.uuid).toBe(
      'provided-user-message-id',
    );
    expect(
      coreMocks.fileHistoryManagerInstances.at(-1)?.makeSnapshot,
    ).toHaveBeenCalledWith('provided-user-message-id');
  });
});
