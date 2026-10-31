/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Turn, LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { parseAndFormatApiError } from '@qwen-code/qwen-code-core/utils/errorParsing.js';
import { getErrorStatus } from '@qwen-code/qwen-code-core/utils/errors.js';
import {
  LlmRequestPreparationError,
  llmPreparedProviderPin,
  type LlmPreparedRequest,
  type LlmPreparedRequestCallback,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { HostedModelRequest } from './hosted-model-recovery.js';
import type { HostedModelSelection } from './hosted-model-selection.js';
import type { PublicChildModelRoute } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { HOSTED_MODEL_REQUEST_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';

import type { Content, Part } from '@google/genai';
import { classifyAction } from '@qwen-code/qwen-code-core/permissions/classifier.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from '@qwen-code/qwen-code-core/agents/runtime/agent-context.js';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import { DEFAULT_TOOL_OUTPUT_BATCH_BUDGET } from '@qwen-code/qwen-code-core/config/config.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type {
  ChatRecord,
  ChatCompressionRecordPayload,
} from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { getApiHistoryPromptId } from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';
import { buildSessionHistoryFromConversation } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

import {
  HostedModelUnavailableError,
  type HostedAgentDefinition,
} from './hosted-agent-definition.js';

import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import type { HostedSkillCatalog } from './hosted-skill-catalog.js';
import {
  HostedHookRecoveryRequiredError,
  type HostedHookSession,
  type HostedPromptHookRunner,
} from './hosted-hook-session.js';
import type { ManagedHookDispatcher } from '@qwen-code/qwen-code-core/hooks/hookEventHandler.js';
import type {
  ManagedHookModelScope,
  ManagedMainModelAttempt,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { createHostedPromptHookRunner } from './hosted-hook-model.js';
import {
  HookEventName,
  createHookOutput,
  type HookInput,
} from '@qwen-code/qwen-code-core/hooks/types.js';

const HOSTED_EXPLICIT_HOOK_EVENTS = new Set<string>([
  HookEventName.SessionStart,
  HookEventName.SessionEnd,
  HookEventName.SessionDelete,
  HookEventName.UserPromptSubmit,
  HookEventName.UserPromptExpansion,
  HookEventName.Stop,
  HookEventName.StopFailure,
  HookEventName.MessageDisplay,
  HookEventName.PreToolUse,
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.PostToolBatch,
  HookEventName.PermissionRequest,
]);

export interface HostedHarnessModelResult {
  text: string;
  parts?: Part[];
  model: string;
}

export const HOSTED_MODEL_API_ERROR_MESSAGES = {
  model_payment_required:
    'Model API payment required (HTTP 402). Check the provider account balance and billing before retrying.',
  model_authentication_failed:
    'Model API authentication failed (HTTP 401). Check the configured provider credentials.',
  model_access_denied:
    'Model API access denied (HTTP 403). Check the provider account and model permissions.',
  model_request_timeout: 'The model API request timed out. Try again later.',
  model_rate_limited:
    'Model API rate limit exceeded (HTTP 429). Wait and try again later.',
  model_request_rejected:
    'The model API rejected the request. Check the model configuration and input.',
  model_service_unavailable:
    'The model API service is unavailable. Try again later.',
  model_request_failed:
    'Model API request failed. Check the server logs for this session before retrying.',
} as const;

export class HostedModelApiError extends Error {
  readonly code: keyof typeof HOSTED_MODEL_API_ERROR_MESSAGES;

  constructor(error: unknown) {
    super(parseAndFormatApiError(error));
    const status = getErrorStatus(error);
    this.code =
      status === 402
        ? 'model_payment_required'
        : status === 401
          ? 'model_authentication_failed'
          : status === 403
            ? 'model_access_denied'
            : status === 408 || status === 504
              ? 'model_request_timeout'
              : status === 429
                ? 'model_rate_limited'
                : status !== undefined && status >= 500
                  ? 'model_service_unavailable'
                  : status !== undefined && status >= 400
                    ? 'model_request_rejected'
                    : 'model_request_failed';
  }
}

export class HostedModelRoundLimitError extends Error {
  constructor() {
    super('The Hosted Harness Turn reached its configured model round limit.');
  }
}

export class HostedImageInputUnsupportedError extends Error {
  constructor() {
    super(
      'The selected model does not support image input. Choose a model with image support or remove the image.',
    );
  }
}

export interface HostedHarnessTextDeltas {
  delta(text: string): Promise<void>;
  /**
   * Retract the current message's published deltas so a restarted attempt
   * replaces them; a no-op when nothing is published (#13319).
   */
  retract(): Promise<void>;
}

/**
 * Applies a Session's AgentDefinition model pin to a fresh per-turn config:
 * exactly one configured, non-runtime model must match, and it is switched
 * to with cached credentials. A pin that does not resolve fails the Turn
 * (the config is shut down first) instead of falling back to the default.
 * Every Turn lane a pinned Session runs — text and workflow alike — goes
 * through here.
 */
export async function applyHostedModelPin(
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  model: HostedAgentDefinition['model'] | undefined,
): Promise<void> {
  if (!model) return;
  try {
    const matches = config
      .getAllConfiguredModels()
      .filter((entry) => !entry.isRuntimeModel && entry.id === model.id);
    if (matches.length !== 1) throw new HostedModelUnavailableError();
    const selected = matches[0]!;
    await config.switchModel(selected.authType, selected.id, {
      requireCachedCredentials: true,
      ...(selected.registryBaseUrl
        ? { baseUrl: selected.registryBaseUrl }
        : {}),
    });
  } catch (cause) {
    try {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    } catch (cleanupCause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Harness model cleanup failed: ${String(cleanupCause)}`,
      );
    }
    throw new HostedModelUnavailableError(cause);
  }
}

export async function applyHostedPublicChildModelPin(
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  model: { id: string } | undefined,
  route: PublicChildModelRoute,
): Promise<void> {
  try {
    const initial = config.getModelsConfig().getGenerationConfig();
    const sameDefault =
      config.getModel() === model?.id &&
      config.getModelsConfig().getCurrentAuthType() === route.authType &&
      createHash('sha256')
        .update(initial.baseUrl ?? '')
        .digest('hex') === route.endpointDigest;
    if (!sameDefault) {
      const matches = config.getAllConfiguredModels().filter(
        (entry) =>
          !entry.isRuntimeModel &&
          entry.id === model?.id &&
          entry.authType === route.authType &&
          createHash('sha256')
            .update(entry.baseUrl ?? '')
            .digest('hex') === route.endpointDigest,
      );
      if (matches.length !== 1) throw new HostedModelUnavailableError();
      const selected = matches[0]!;
      await config.switchModel(selected.authType, selected.id, {
        requireCachedCredentials: true,
        ...(selected.registryBaseUrl
          ? { baseUrl: selected.registryBaseUrl }
          : {}),
      });
    }
  } catch (cause) {
    try {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    } catch (cleanupCause) {
      writeStderrLineSafe(
        `qwen serve: Hosted child model cleanup failed: ${String(cleanupCause)}`,
      );
    }
    throw new HostedModelUnavailableError(cause);
  }
}

export function hostedToolOutputBudget(cwd: string): number {
  return (
    loadSettings(cwd, {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    }).merged.tools?.toolOutputBatchBudget ?? DEFAULT_TOOL_OUTPUT_BATCH_BUDGET
  );
}

export async function runHostedHarnessTextTurn(input: {
  sessionId: string;
  cwd: string;
  history: readonly ChatRecord[];
  excludedPromptIds?: ReadonlySet<string>;
  classifierUserText?: () => Promise<ReadonlyMap<string, string>>;
  commitCompression?: (payload: ChatCompressionRecordPayload) => Promise<void>;
  prompt: string;
  attachmentParts?: readonly Part[];
  promptId: string;
  userMessages?: {
    claim(): Promise<
      ReadonlyArray<{
        id: string;
        parts: Part[];
        text: string;
        attachments?: Part[];
      }>
    >;
    commit(id: string, parts: Part[]): Promise<void>;
    commitAssistant(parts: Part[], model: string): Promise<void>;
  };
  signal: AbortSignal;
  resumeFromToolResults?: readonly Part[];
  initialRound?: number;
  resumeModel?: HostedModelRequest;
  prepareModel?: (
    prepared: LlmPreparedRequest,
    round: number,
    pendingToolResults: boolean,
    context: string | undefined,
    captureUnsupported?: boolean,
  ) => Promise<
    | import('@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js').ManagedSessionDurableRef
    | undefined
  >;
  hooks?: HostedHookSession;
  modelScope?: ManagedHookModelScope;
  toolTurn?: Pick<
    HostedWorkspaceToolTurn,
    'execute' | 'consumeResults' | 'declarations'
  > &
    Partial<
      Pick<
        HostedWorkspaceToolTurn,
        | 'setPromptHookRunner'
        | 'setPermissionClassifier'
        | 'resumeHookResults'
        | 'hookStopReason'
        | 'setModelRound'
        | 'setToolOutputBudget'
        | 'capturesChildModelRoute'
        | 'setChildModelRoute'
        | 'setChildModelResolver'
        | 'planModeInstructions'
        | 'todoInstructions'
      >
    >;
  workspaceContext?: { read(): string | undefined };
  agentDefinition?: HostedAgentDefinition;
  modelSelection?: HostedModelSelection;
  publicChildModelRoute?: PublicChildModelRoute;
  agentInstructions?: string;
  extensionInstructions?: string;
  skills?: HostedSkillCatalog;
  textDeltas?: HostedHarnessTextDeltas;
  completeFinalOutput?: (
    attempt: ManagedMainModelAttempt,
    usage: unknown[],
    parts: Part[],
    model: string,
  ) => Promise<void>;
}): Promise<HostedHarnessModelResult> {
  const settings = loadSettings(input.cwd, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: false,
  });
  const argv = {
    acp: true,
    safeMode: true,
    chatRecording: false,
    sessionId: input.sessionId,
    // The Hosted store owns this ID, independently of local transcripts.
    sessionIdGenerated: true,
  } as CliArgs;
  const config = await loadCliConfig(
    settings.merged,
    argv,
    input.cwd,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
    { toolInvocationGuard: () => ({ allowed: false }) },
  );
  const outputBudget = config.getToolOutputBatchBudget?.();
  if (outputBudget !== undefined)
    input.toolTurn?.setToolOutputBudget?.(outputBudget);
  const model = input.modelSelection
    ? { id: input.modelSelection.modelId }
    : input.agentDefinition?.model;
  if (input.publicChildModelRoute)
    await applyHostedPublicChildModelPin(
      config,
      input.publicChildModelRoute.origin
        ? { id: input.publicChildModelRoute.origin.modelId }
        : model,
      input.publicChildModelRoute.origin ?? input.publicChildModelRoute,
    );
  else await applyHostedModelPin(config, model);
  if (input.publicChildModelRoute?.origin) {
    // Config falls back to its own generator until authentication fills this frame.
    const view = {} as RuntimeContentGeneratorView;
    return runWithRuntimeContentGenerator(view, () =>
      runPreparedHostedHarnessTextTurn(input, config, model, view),
    );
  }
  return runPreparedHostedHarnessTextTurn(input, config, model);
}

async function runPreparedHostedHarnessTextTurn(
  input: Parameters<typeof runHostedHarnessTextTurn>[0],
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  model: HostedAgentDefinition['model'] | undefined,
  runtimeView?: RuntimeContentGeneratorView,
): Promise<HostedHarnessModelResult> {
  let todoContext = await input.toolTurn?.todoInstructions?.();
  const contextWithInstructions = (context: string | undefined) =>
    [
      input.agentInstructions
        ? `# Agent instructions\n\n${input.agentInstructions}`
        : undefined,
      input.extensionInstructions,
      input.skills?.instructions(),
      input.toolTurn?.planModeInstructions?.(),
      todoContext,
      context,
    ]
      .filter(Boolean)
      .join('\n\n');
  let runPromptHook: HostedPromptHookRunner | undefined;
  let modelReady = false;
  let historyReady = false;
  let pendingToolResults =
    input.resumeFromToolResults !== undefined ||
    (input.resumeModel?.pendingToolResults ?? false);
  const excludeUnanswered = (history: Content[]) => {
    let excluded = false;
    return history.filter((entry) => {
      const promptId = getApiHistoryPromptId(entry);
      // Compression marks prompts alone. Tool rounds and unmarked queued
      // guidance belong to that boundary until the next marked prompt.
      if (promptId !== undefined)
        excluded = input.excludedPromptIds?.has(promptId) ?? false;
      return !excluded;
    });
  };
  const initialMessages: Content[] = excludeUnanswered(
    buildSessionHistoryFromConversation({
      messages: input.history,
    }).apiHistory,
  );
  if (!input.resumeFromToolResults && !input.resumeModel)
    initialMessages.push({
      role: 'user',
      parts: [
        ...(input.prompt ? [{ text: input.prompt }] : []),
        ...(input.attachmentParts ?? []),
      ],
    });
  const initializationHooks: Array<{
    fields: HookInput;
    signal?: AbortSignal;
  }> = [];
  const nativeOccurrences = new Map<string, number>();
  const fire = async (
    event: HookEventName,
    occurrence: string,
    fields: Record<string, unknown>,
    signal = input.signal,
  ) => {
    const result = await input.hooks?.fire(
      event,
      occurrence,
      {
        ...fields,
        prompt_id: input.promptId,
        messages: structuredClone(
          fields['messages'] ??
            (historyReady
              ? config.getLlmClient().getHistory()
              : initialMessages),
        ),
      },
      signal,
      runPromptHook,
    );
    return result ? createHookOutput(event, result) : undefined;
  };
  const dispatcher: ManagedHookDispatcher = {
    hasHooksForEvent: (event) =>
      !HOSTED_EXPLICIT_HOOK_EVENTS.has(event) &&
      (input.hooks
        ?.getCatalog()
        ?.hooks.some((hook) => hook.eventName === event) ??
        false),
    async execute(event, fields, signal) {
      const empty = {
        success: true,
        allOutputs: [],
        errors: [],
        totalDuration: 0,
      };
      if (!modelReady) {
        if (event !== HookEventName.InstructionsLoaded)
          throw new HostedHookRecoveryRequiredError();
        initializationHooks.push({ fields, signal });
        return empty;
      }
      const stableFields = { ...fields, timestamp: undefined };
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            event,
            fields: { ...stableFields, messages: undefined },
            resumedAfter:
              event !== HookEventName.InstructionsLoaded &&
              input.resumeFromToolResults
                ? input.history.at(-1)?.uuid
                : null,
          }),
        )
        .digest('hex');
      const ordinal = nativeOccurrences.get(key) ?? 0;
      nativeOccurrences.set(key, ordinal + 1);
      const occurrenceId = `${input.promptId}:native:${key}:${ordinal}`;
      if (
        event === HookEventName.InstructionsLoaded &&
        input.hooks?.hasCompletedOccurrence(event, occurrenceId)
      )
        return empty;
      try {
        const output = await fire(event, occurrenceId, stableFields, signal);
        return {
          ...empty,
          allOutputs: output ? [output] : [],
          finalOutput: output,
        };
      } catch {
        throw new HostedHookRecoveryRequiredError();
      }
    },
  };
  try {
    await input.hooks?.ensureReady(input.signal);
    // Seed instructions when memory reload is skipped; restore them after
    // initialize() when its hierarchical memory refresh replaces user memory.
    if (input.agentInstructions || input.extensionInstructions || input.skills)
      config.setUserMemory(
        contextWithInstructions(input.workspaceContext?.read()),
      );
    await config.initialize({
      signal: input.signal,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
      ...(runtimeView ? { skipLlmInitialization: true } : {}),
      ...(input.hooks ? { managedHookDispatcher: dispatcher } : {}),
    });
    const authType = config.getModelsConfig().getCurrentAuthType();
    if (!authType)
      throw new Error('Hosted Harness model authentication is unavailable.');
    if (
      input.agentInstructions ||
      input.extensionInstructions ||
      input.skills
    ) {
      config.setUserMemory(
        contextWithInstructions(input.workspaceContext?.read()),
      );
    }
    try {
      await config.refreshAuth(authType, true);
    } catch (cause) {
      if (model) throw new HostedModelUnavailableError(cause);
      throw cause;
    }
    const origin = input.publicChildModelRoute?.origin;
    if (origin) {
      if (
        llmPreparedProviderPin(config.getContentGeneratorConfig()) !==
        origin.providerPin
      )
        throw new HostedModelUnavailableError();
      const route = input.publicChildModelRoute!;
      const matches = config.getAllConfiguredModels().filter(
        (entry) =>
          !entry.isRuntimeModel &&
          entry.id === model?.id &&
          entry.authType === route.authType &&
          createHash('sha256')
            .update(entry.baseUrl ?? '')
            .digest('hex') === route.endpointDigest,
      );
      if (matches.length !== 1) throw new HostedModelUnavailableError();
      const selected = matches[0];
      const resolved = await config
        .getBaseLlmClient()
        .resolveForModel(
          `${selected.authType}:${selected.id}${selected.registryBaseUrl ? `\0${selected.registryBaseUrl}` : ''}`,
          { failClosed: true },
        );
      if (
        llmPreparedProviderPin(resolved.contentGeneratorConfig) !==
        route.providerPin
      )
        throw new HostedModelUnavailableError();
      Object.assign(runtimeView!, {
        contentGenerator: resolved.contentGenerator,
        contentGeneratorConfig: resolved.contentGeneratorConfig,
      });
      await config.getLlmClient().initialize(undefined, input.signal);
    }
    if (
      input.publicChildModelRoute &&
      llmPreparedProviderPin(config.getContentGeneratorConfig()) !==
        input.publicChildModelRoute.providerPin
    ) {
      throw new HostedModelUnavailableError();
    }
    const captureChildRoute = async (prepared: LlmPreparedRequest) => {
      if (
        input.publicChildModelRoute &&
        prepared.providerPin !== input.publicChildModelRoute.providerPin
      )
        throw new HostedModelUnavailableError();
      if (!input.toolTurn?.capturesChildModelRoute?.()) return;
      const active = config.getContentGeneratorConfig();
      let routed: typeof active | undefined = active;
      if (prepared.providerPin !== llmPreparedProviderPin(active)) {
        routed = undefined;
        for (const selector of new Set([
          ...config.getModelFallbacks(),
          prepared.routeSelector,
        ])) {
          try {
            const candidate = (
              await config
                .getBaseLlmClient()
                .resolveForModel(selector, { failClosed: true })
            ).contentGeneratorConfig;
            if (prepared.providerPin === llmPreparedProviderPin(candidate)) {
              routed = candidate;
              break;
            }
          } catch {
            continue;
          }
        }
      }
      if (
        !routed?.authType ||
        prepared.providerPin !== llmPreparedProviderPin(routed)
      )
        throw new HostedModelUnavailableError();
      input.toolTurn.setChildModelRoute?.(prepared.request.model, {
        authType: routed.authType,
        endpointDigest: createHash('sha256')
          .update(routed.baseUrl ?? '')
          .digest('hex'),
        providerPin: prepared.providerPin,
        ...(prepared.providerPin !== llmPreparedProviderPin(active)
          ? {
              origin: {
                modelId: config.getModel(),
                authType: active.authType!,
                endpointDigest: createHash('sha256')
                  .update(active.baseUrl ?? '')
                  .digest('hex'),
                providerPin: llmPreparedProviderPin(active),
              },
            }
          : {}),
      });
      input.toolTurn.setChildModelResolver?.(async (selector) => {
        const resolved = await config
          .getBaseLlmClient()
          .resolveForModel(selector, { failClosed: true });
        const selected = resolved.contentGeneratorConfig;
        if (!selected.authType) throw new HostedModelUnavailableError();
        return {
          modelId: resolved.model,
          route: {
            authType: selected.authType,
            endpointDigest: createHash('sha256')
              .update(selected.baseUrl ?? '')
              .digest('hex'),
            providerPin: llmPreparedProviderPin(selected),
            origin: {
              modelId: config.getModel(),
              authType: active.authType!,
              endpointDigest: createHash('sha256')
                .update(active.baseUrl ?? '')
                .digest('hex'),
              providerPin: llmPreparedProviderPin(active),
            },
          },
        };
      });
    };
    if (
      [...initialMessages, ...(input.resumeModel?.prepared.history ?? [])].some(
        (message) =>
          message.parts?.some((part) =>
            part.inlineData?.mimeType?.startsWith('image/'),
          ),
      ) &&
      config.getEffectiveInputModalities().image !== true
    )
      throw new HostedImageInputUnsupportedError();
    if (input.agentInstructions || input.extensionInstructions || input.skills)
      await config.getLlmClient().refreshSystemInstruction();
    await input.modelScope?.bindBudget(config.getTurnBudget(), input.prompt);
    runPromptHook = input.modelScope
      ? createHostedPromptHookRunner(config, input.modelScope)
      : undefined;
    if (runPromptHook) input.toolTurn?.setPromptHookRunner?.(runPromptHook);
    modelReady = true;
    let effectivePrompt = input.prompt;
    if (input.hooks && !input.resumeFromToolResults && !input.resumeModel) {
      const startupId = `session-start:${input.sessionId}`;
      const start = input.hooks.hasCompletedOccurrence(
        HookEventName.SessionStart,
        startupId,
      )
        ? undefined
        : await fire(HookEventName.SessionStart, startupId, {
            source: 'startup',
          });
      if (start?.shouldStopExecution() || start?.isBlockingDecision())
        throw new Error('Hook blocked the model request.');
      for (const queued of initializationHooks)
        await dispatcher.execute(
          HookEventName.InstructionsLoaded,
          queued.fields,
          queued.signal,
        );
      const submit = await fire(
        HookEventName.UserPromptSubmit,
        input.promptId,
        { prompt: input.prompt, submitted_prompt: input.prompt },
      );
      if (submit?.shouldStopExecution() || submit?.isBlockingDecision())
        throw new Error('Hook blocked the model request.');
      const updated = submit?.hookSpecificOutput?.['updatedPrompt'];
      effectivePrompt = typeof updated === 'string' ? updated : input.prompt;
      const context = [
        start?.getAdditionalContext(),
        submit?.getAdditionalContext(),
      ]
        .filter(Boolean)
        .join('\n');
      if (context) effectivePrompt += `\n${context}`;
    } else {
      for (const queued of initializationHooks)
        await dispatcher.execute(
          HookEventName.InstructionsLoaded,
          queued.fields,
          queued.signal,
        );
    }
    const textDeltas = input.hooks
      ?.getCatalog()
      ?.hooks.some(
        (hook) =>
          hook.eventName === HookEventName.Stop ||
          hook.eventName === HookEventName.MessageDisplay,
      )
      ? undefined
      : input.textDeltas;
    const client = config.getLlmClient();
    const registry = config.getToolRegistry();
    await registry.warmAll();
    for (const tool of registry.getAllTools())
      registry.unregisterTool(tool.name);
    await client.setTools();
    if (registry.getFunctionDeclarations().length !== 0) {
      throw new Error('Hosted Harness cannot advertise local tools.');
    }
    let originalUserText: Promise<ReadonlyMap<string, string>> | undefined;
    const classifierActions: Content[] = [];
    input.toolTurn?.setPermissionClassifier?.(async (call, signal) => {
      originalUserText ??=
        input.classifierUserText?.() ??
        Promise.resolve(new Map([[input.promptId, input.prompt]]));
      let userText: ReadonlyMap<string, string>;
      try {
        userText = await originalUserText;
      } catch (cause) {
        if (signal.aborted) throw cause;
        return {
          shouldBlock: true,
          reason: '',
          unavailable: true,
          model: config.getModel(),
          stage: 'fast',
          durationMs: 0,
        };
      }
      if (!userText.has(input.promptId))
        return {
          shouldBlock: true,
          reason: '',
          unavailable: true,
          model: config.getModel(),
          stage: 'fast',
          durationMs: 0,
        };
      const messages: Content[] = input.history.flatMap((record) => {
        if (record.type !== 'user' && record.type !== 'assistant') return [];
        if (input.excludedPromptIds?.has(record.daemonPromptId ?? ''))
          return [];
        if (record.type === 'user') {
          if (
            (record.provenance !== undefined &&
              record.provenance !== 'real_user') ||
            record.subtype === 'agent_message' ||
            record.subtype === 'agent_mention'
          )
            return [];
          const text = userText.get(record.daemonPromptId ?? '');
          return text ? [{ role: 'user', parts: [{ text }] }] : [];
        }
        const parts =
          record.message?.parts?.filter((part) => !!part.functionCall) ?? [];
        return parts.length ? [{ role: 'model', parts }] : [];
      });
      const prompt = userText.get(input.promptId);
      if (!input.resumeFromToolResults && !input.resumeModel && prompt)
        messages.push({ role: 'user', parts: [{ text: prompt }] });
      const result = await classifyAction({
        toolName: call.name,
        toolParams: call.args,
        messages: [...messages, ...classifierActions],
        config,
        signal,
      });
      classifierActions.push({
        role: 'model',
        parts: [
          {
            functionCall: { id: call.callId, name: call.name, args: call.args },
          },
        ],
      });
      return result;
    });
    // Safe mode stays on; the Session's Workspace instructions arrive through
    // the context slot instead of the Harness host's filesystem. The loop below
    // injects them before the first request too.
    let injectedContext: string | undefined;
    let injectedTools: ReadonlySet<string> | undefined;
    const lastAssistant = input.history.findLastIndex(
      (record) => record.type === 'assistant',
    );
    const resumedIds = new Set(
      input.resumeFromToolResults?.flatMap((part) =>
        part.functionResponse?.id ? [part.functionResponse.id] : [],
      ),
    );
    const historyRecords = input.resumeFromToolResults
      ? input.history.flatMap((record, index) => {
          if (index <= lastAssistant) return [record];
          if (record.type !== 'system' || record.subtype !== 'chat_compression')
            return [];
          const payload = record.systemPayload as ChatCompressionRecordPayload;
          const prefix = payload.summaryPrefixLength;
          const pending = payload.compressedHistory?.at(-1);
          const responses = pending?.parts?.flatMap((part) =>
            part.functionResponse ? [part.functionResponse] : [],
          );
          // A pre-send snapshot owns the pending response too. Restore its
          // compressed prefix, then send that response through the resume path.
          if (
            typeof prefix !== 'number' ||
            !Number.isSafeInteger(prefix) ||
            prefix < 0 ||
            payload.compressedHistory.length !== prefix + 1 ||
            pending?.role !== 'user' ||
            !responses?.length ||
            responses.some((response) => !resumedIds.has(response.id ?? ''))
          )
            return [record];
          return [
            {
              ...record,
              systemPayload: {
                ...payload,
                compressedHistory: payload.compressedHistory.slice(0, prefix),
                ...(payload.promptIds
                  ? { promptIds: payload.promptIds.slice(0, prefix) }
                  : {}),
              },
            },
          ];
        })
      : input.history;
    const restored = buildSessionHistoryFromConversation({
      messages: historyRecords,
    });
    const history = excludeUnanswered(restored.apiHistory);
    if (input.commitCompression)
      client.setCompressionObserver(input.commitCompression, {
        restoreRecentFiles: false,
      });
    // Text-only turns need a visible answer; curated history can drop an
    // empty assistant record while keeping its prompt. Tool-profile turns
    // can carry calls without text and use journal-based group exclusion.
    const answered = (entry: Content | undefined): boolean =>
      entry?.role === 'model' &&
      !!entry.parts?.some((part) => !part.thought && !!part.text);
    client
      .getChat()
      .setHistory(
        input.toolTurn
          ? history
          : history.filter((entry, index) =>
              entry.role === 'user'
                ? answered(history[index + 1])
                : answered(entry),
            ),
      );
    client.getChat().setCompletedToolCallIds?.(restored.completedToolCallIds);
    historyReady = true;
    input.hooks?.setMessagesProvider(() =>
      client.getHistory().map((message) => ({ ...message })),
    );
    let request: Part[] = input.resumeFromToolResults
      ? ((await input.toolTurn?.resumeHookResults?.(
          input.resumeFromToolResults,
          config.getModel(),
          input.signal,
        )) ?? [...input.resumeFromToolResults])
      : [
          ...(effectivePrompt ? [{ text: effectivePrompt }] : []),
          ...(input.attachmentParts ?? []),
        ];
    const selectedSkills =
      !input.resumeFromToolResults && !input.resumeModel && input.toolTurn
        ? (input.skills?.invocations(effectivePrompt) ?? [])
        : [];
    if (selectedSkills.length && input.toolTurn) {
      const calls: ToolCallRequestInfo[] = selectedSkills.map((skill) => ({
        callId: randomUUID(),
        name: 'skill',
        args: { skill, ...input.skills?.userArguments(skill, effectivePrompt) },
        isClientInitiated: true,
        origin: { kind: 'client' },
        prompt_id: input.promptId,
      }));
      const parts: Part[] = calls.map((call) => ({
        functionCall: { id: call.callId, name: call.name, args: call.args },
      }));
      client
        .getChat()
        .setHistory([
          ...history,
          { role: 'user', parts: request },
          { role: 'model', parts },
        ]);
      input.toolTurn.setModelRound?.(input.initialRound ?? 0);
      request = await input.toolTurn.execute(
        calls,
        parts,
        config.getModel(),
        input.signal,
      );
      pendingToolResults = true;
    }
    let preparedRecovery = input.resumeModel?.prepared;
    let stopHookActive =
      (await input.hooks?.wasStopBlocked(input.promptId)) ?? false;
    let guidanceRequest = false;
    const drainUserMessages = async (
      includeRequest: boolean,
    ): Promise<boolean> => {
      if (!input.userMessages || preparedRecovery) return false;
      input.signal.throwIfAborted();
      const messages = await input.userMessages.claim();
      if (!messages.length) return false;
      const additions: Content[] = [];
      for (const message of messages) {
        input.signal.throwIfAborted();
        let parts = message.parts;
        const submit = await fire(HookEventName.UserPromptSubmit, message.id, {
          prompt: message.text,
          submitted_prompt: message.text,
        });
        if (submit?.shouldStopExecution() || submit?.isBlockingDecision())
          throw new Error('Hook blocked queued user input.');
        const updated = submit?.hookSpecificOutput?.['updatedPrompt'];
        const context = submit?.getAdditionalContext();
        if (typeof updated === 'string' || context) {
          parts = [
            {
              text: `${typeof updated === 'string' ? updated : message.text}${context ? `\n${context}` : ''}`,
            },
            ...(message.attachments ?? parts.filter((part) => !part.text)),
          ];
        }
        await input.userMessages.commit(message.id, parts);
        additions.push({ role: 'user', parts });
      }
      client
        .getChat()
        .setHistory([
          ...client.getHistory(),
          ...(includeRequest ? [{ role: 'user', parts: request }] : []),
          ...additions.slice(0, -1),
        ]);
      request = additions.at(-1)!.parts!;
      guidanceRequest = true;
      return true;
    };
    const maxRounds = config.getMaxSessionTurns();
    for (
      let round = input.resumeModel?.round ?? input.initialRound ?? 0;
      ;
      round++
    ) {
      input.signal.throwIfAborted();
      input.toolTurn?.setModelRound?.(round);
      if (input.hooks?.hasPendingOperations)
        throw new HostedHookRecoveryRequiredError();
      if (input.toolTurn?.hookStopReason) {
        const text = input.toolTurn.hookStopReason;
        return { text, parts: [{ text }], model: config.getModel() };
      }
      if (maxRounds > 0 && round >= maxRounds)
        throw new HostedModelRoundLimitError();
      await drainUserMessages(true);
      const declarations =
        (await input.toolTurn?.declarations(input.signal)) ?? [];
      client
        .getChat()
        .setTools(
          declarations.length ? [{ functionDeclarations: declarations }] : [],
        );
      if (!preparedRecovery) {
        todoContext = await input.toolTurn?.todoInstructions?.();
        const toolNames = new Set(
          declarations
            .map(({ name }) => name)
            .filter((name): name is string => Boolean(name)),
        );
        const previousTools = injectedTools;
        const toolsChanged =
          !previousTools ||
          toolNames.size !== previousTools.size ||
          [...toolNames].some((name) => !previousTools.has(name));
        const contextAvailable =
          contextWithInstructions(input.workspaceContext?.read()) || undefined;
        const contextChanged =
          (contextAvailable !== undefined || injectedContext !== undefined) &&
          contextAvailable !== injectedContext;
        if (toolsChanged) {
          config.setPromptToolSnapshot(toolNames);
          // Hosted does not expose the local deferred-tool bridge.
          config.setPromptAgentReachable(toolNames.has(ToolNames.AGENT));
          injectedTools = toolNames;
        }
        if (contextChanged) {
          config.setUserMemory(contextAvailable ?? '');
          injectedContext = contextAvailable;
        }
        // Config changes alone do not update the chat's cached instruction.
        if (toolsChanged || contextChanged)
          await client.refreshSystemInstruction();
      }
      let calls: ToolCallRequestInfo[] = [];
      let text = '';
      let finished = false;
      let modelFailure = true;
      let completeAttempt:
        | Awaited<ReturnType<ManagedHookModelScope['beginMainAttempt']>>
        | undefined = input.prepareModel
        ? undefined
        : await input.modelScope?.beginMainAttempt(config.getModel());
      let modelOccurrence =
        completeAttempt?.attemptId ?? `${input.promptId}:${round}`;
      let contextWindowSize =
        config.getContentGeneratorConfig()?.contextWindowSize;
      const prepare: LlmPreparedRequestCallback = async (
        prepared,
        captureUnsupported,
      ) => {
        await captureChildRoute(prepared);
        const activeConfig = config.getContentGeneratorConfig();
        contextWindowSize =
          prepared.providerPin === llmPreparedProviderPin(activeConfig)
            ? activeConfig?.contextWindowSize
            : undefined;
        if (completeAttempt) {
          const previous = completeAttempt;
          completeAttempt = undefined;
          await previous(finished, usage);
        }
        const recoveryRef = await input.prepareModel?.(
          prepared,
          round,
          pendingToolResults,
          input.workspaceContext?.read(),
          captureUnsupported,
        );
        completeAttempt = await input.modelScope?.beginMainAttempt(
          prepared.request.model,
          recoveryRef,
        );
        modelOccurrence = completeAttempt?.attemptId ?? modelOccurrence;
        finished = false;
        usage.length = 0;
      };
      prepare.maxSnapshotBytes = HOSTED_MODEL_REQUEST_BYTES;
      const usage: unknown[] = [];
      let finalOutputHandled = false;
      try {
        const stream = preparedRecovery
          ? new Turn(
              client.getChat(),
              input.promptId,
              undefined,
              undefined,
              true,
              prepare,
            ).run(
              preparedRecovery.request.model,
              [],
              input.signal,
              preparedRecovery,
            )
          : client.sendMessageStream(request, input.signal, input.promptId, {
              type:
                guidanceRequest || (round === 0 && !pendingToolResults)
                  ? SendMessageType.UserQuery
                  : SendMessageType.ToolResult,
              // Published deltas cannot be un-glued after the fact: a cut that
              // already delivered content replays the request, and the RETRY
              // handling below retracts the orphaned prefix (#13319).
              retractDeliveredOutputOnRetry: true,
              ...(input.prepareModel ||
              input.publicChildModelRoute ||
              input.toolTurn?.capturesChildModelRoute?.()
                ? { onPreparedRequest: prepare }
                : {}),
            });
        preparedRecovery = undefined;
        guidanceRequest = false;
        for await (const event of stream) {
          if (event.type === LlmEventType.Content) {
            text += event.value;
            await textDeltas?.delta(event.value);
          } else if (event.type === LlmEventType.Finished) {
            finished = true;
            const reported = event.value?.usageMetadata;
            if (reported) {
              const snapshot: Record<string, unknown> = { ...reported };
              delete snapshot['contextWindowSize'];
              if (
                typeof contextWindowSize === 'number' &&
                Number.isSafeInteger(contextWindowSize) &&
                contextWindowSize > 0
              )
                snapshot['contextWindowSize'] = contextWindowSize;
              usage.push(snapshot);
            } else usage.push(null);
          } else if (event.type === LlmEventType.Retry) {
            calls = [];
            if (!event.isContinuation) {
              // A restarted attempt replaces what the failed one published:
              // retract the orphaned prefix from the durable feed before the
              // replay's own deltas arrive (#13319).
              await textDeltas?.retract();
              text = '';
            }
          } else if (event.type === LlmEventType.ModelFallback) {
            contextWindowSize = undefined;
            if (!input.prepareModel && input.modelScope) {
              const previous = completeAttempt;
              completeAttempt = undefined;
              await previous?.(false, usage);
              finished = false;
              usage.length = 0;
              completeAttempt = await input.modelScope.beginMainAttempt(
                event.toModel,
              );
              modelOccurrence = completeAttempt.attemptId ?? modelOccurrence;
            }
            await textDeltas?.retract();
            calls = [];
            text = '';
          } else if (
            event.type === LlmEventType.ToolCallRequest &&
            input.toolTurn
          ) {
            calls.push(event.value);
          } else if (
            event.type === LlmEventType.ToolCallRequest ||
            event.type === LlmEventType.ToolCallConfirmation ||
            event.type === LlmEventType.ToolCallResponse
          ) {
            modelFailure = false;
            throw new Error('Hosted Harness no-tool turn refused a tool call.');
          } else if (event.type === LlmEventType.Error) {
            // Format rather than flatten: the formatter keeps a resolved provider
            // request id on the message, so the daemon stderr line and the
            // StopFailure hook's error_details keep an id the operator can
            // quote to their provider.
            throw new HostedModelApiError(event.value.error);
          } else if (event.type === LlmEventType.UserCancelled) {
            modelFailure = false;
            throw new Error('Hosted Harness turn was cancelled.');
          } else if (event.type === LlmEventType.MaxSessionTurns) {
            modelFailure = false;
            throw new HostedModelRoundLimitError();
          } else if (
            event.type !== LlmEventType.ChatCompressed &&
            event.type !== LlmEventType.Thought &&
            event.type !== LlmEventType.Citation
          ) {
            modelFailure = false;
            throw new Error(
              'Hosted Harness model returned an unsupported continuation.',
            );
          }
        }
        if (!finished)
          throw new Error('Hosted Harness model turn did not finish.');
        if (
          input.completeFinalOutput &&
          completeAttempt &&
          input.toolTurn &&
          pendingToolResults &&
          !input.hooks &&
          !input.userMessages &&
          calls.length === 0
        ) {
          const output = client.getHistory().at(-1);
          if (
            output?.role !== 'model' ||
            !output.parts ||
            output.parts.some((part) => part.functionCall)
          )
            throw new Error('Hosted final model output is unavailable.');
          finalOutputHandled = true;
          await input.completeFinalOutput(
            completeAttempt,
            usage,
            structuredClone(output.parts),
            config.getModel(),
          );
        }
      } catch (cause) {
        if (
          modelFailure &&
          !input.signal.aborted &&
          !(cause instanceof HostedHookRecoveryRequiredError) &&
          !(cause instanceof LlmRequestPreparationError)
        ) {
          await fire(
            HookEventName.StopFailure,
            `${modelOccurrence}:model-failure`,
            {
              error: 'unknown',
              error_details:
                cause instanceof Error ? cause.message : String(cause),
              last_assistant_message: text,
            },
          );
        }
        throw cause;
      } finally {
        if (!finalOutputHandled) await completeAttempt?.(finished, usage);
      }
      if (pendingToolResults && input.toolTurn) {
        await input.toolTurn.consumeResults();
        pendingToolResults = false;
      }
      let suppressDisplay = false;
      if (calls.length === 0) {
        const stopped = await fire(HookEventName.Stop, modelOccurrence, {
          stop_hook_active: stopHookActive,
          last_assistant_message: text,
        });
        if (stopped?.isBlockingDecision() || stopped?.shouldStopExecution()) {
          stopHookActive = true;
          request = [
            { text: stopped.getEffectiveReason() || 'Continue working.' },
          ];
          continue;
        }
        const display = await fire(
          HookEventName.MessageDisplay,
          modelOccurrence,
          {
            message_id: modelOccurrence,
            displayed_text: text,
            is_final: true,
          },
        );
        suppressDisplay = display?.suppressOutput ?? false;
        if (suppressDisplay) text = '';
      }
      const output = client.getHistory().at(-1);
      if (output?.role !== 'model' || !output.parts)
        throw new Error('Hosted model output is unavailable.');
      const parts = structuredClone(output.parts);
      if (calls.length === 0 && input.userMessages) {
        const waiting =
          maxRounds > 0 && round + 1 >= maxRounds
            ? []
            : await input.userMessages.claim();
        if (waiting.length) {
          await input.userMessages.commitAssistant(
            suppressDisplay ? [] : parts,
            config.getModel(),
          );
          // Keep the final assistant record ahead of newly admitted guidance.
          const original = input.userMessages;
          input.userMessages = { ...original, claim: async () => waiting };
          try {
            await drainUserMessages(false);
          } finally {
            input.userMessages = original;
          }
          continue;
        }
      }
      if (!input.toolTurn)
        return {
          text,
          parts: suppressDisplay ? [] : parts,
          model: config.getModel(),
        };
      const functions = parts.filter((part) => part.functionCall);
      if (functions.length !== calls.length)
        throw new Error('Hosted model call history is inconsistent.');
      for (const [index, part] of functions.entries()) {
        const call = calls[index];
        if (part.functionCall!.name !== call.name)
          throw new Error('Hosted model call identity changed.');
        part.functionCall!.id = call.callId;
      }
      if (calls.length === 0)
        return {
          text,
          parts: suppressDisplay ? [] : parts,
          model: config.getModel(),
        };
      request = await input.toolTurn.execute(
        calls,
        parts,
        config.getModel(),
        input.signal,
      );
      pendingToolResults = true;
    }
  } catch (cause) {
    if (
      cause instanceof ManagedSessionRecordError ||
      cause instanceof HostedToolRecoveryRequiredError
    )
      throw cause;
    if (pendingToolResults && input.completeFinalOutput)
      throw new HostedToolRecoveryRequiredError(cause);
    throw cause;
  } finally {
    input.hooks?.setMessagesProvider(undefined);
    try {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Harness model cleanup failed: ${String(cause)}`,
      );
    }
  }
}
