/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Turn, LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { parseAndFormatApiError } from '@qwen-code/qwen-code-core/utils/errorParsing.js';
import {
  LlmRequestPreparationError,
  llmPreparedProviderPin,
  type LlmPreparedRequest,
  type LlmPreparedRequestCallback,
} from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { HostedModelRequest } from './hosted-model-recovery.js';
import type { HostedModelSelection } from './hosted-model-selection.js';
import { HOSTED_MODEL_REQUEST_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';

import type { Content, Part } from '@google/genai';
import { createHash, randomUUID } from 'node:crypto';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import { ToolNames } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
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

export async function runHostedHarnessTextTurn(input: {
  sessionId: string;
  cwd: string;
  history: readonly ChatRecord[];
  prompt: string;
  attachmentParts?: readonly Part[];
  promptId: string;
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
        | 'resumeHookResults'
        | 'hookStopReason'
        | 'setModelRound'
        | 'planModeInstructions'
      >
    >;
  workspaceContext?: { read(): string | undefined };
  agentDefinition?: HostedAgentDefinition;
  modelSelection?: HostedModelSelection;
  agentInstructions?: string;
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
  const contextWithInstructions = (context: string | undefined) =>
    [
      input.agentInstructions
        ? `# Agent instructions\n\n${input.agentInstructions}`
        : undefined,
      input.skills?.instructions(),
      input.toolTurn?.planModeInstructions?.(),
      context,
    ]
      .filter(Boolean)
      .join('\n\n');
  const model = input.modelSelection
    ? { id: input.modelSelection.modelId }
    : input.agentDefinition?.model;
  await applyHostedModelPin(config, model);
  let runPromptHook: HostedPromptHookRunner | undefined;
  let modelReady = false;
  let historyReady = false;
  let pendingToolResults =
    input.resumeFromToolResults !== undefined ||
    (input.resumeModel?.pendingToolResults ?? false);
  const initialMessages: Content[] = input.history.flatMap((record) =>
    (record.type === 'user' ||
      record.type === 'assistant' ||
      record.type === 'tool_result') &&
    record.message?.parts
      ? [
          {
            role: record.type === 'assistant' ? 'model' : 'user',
            parts: record.message.parts,
          },
        ]
      : [],
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
    if (input.agentInstructions || input.skills)
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
      ...(input.hooks ? { managedHookDispatcher: dispatcher } : {}),
    });
    const authType = config.getModelsConfig().getCurrentAuthType();
    if (!authType)
      throw new Error('Hosted Harness model authentication is unavailable.');
    if (input.agentInstructions || input.skills) {
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
    if (input.agentInstructions || input.skills)
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
    // Safe mode stays on; the Session's Workspace instructions arrive through
    // the context slot instead of the Harness host's filesystem. The loop below
    // injects them before the first request too.
    let injectedContext: string | undefined;
    let injectedTools: ReadonlySet<string> | undefined;
    const historyRecords = input.resumeFromToolResults
      ? input.history.slice(
          0,
          input.history.findLastIndex((record) => record.type === 'assistant') +
            1,
        )
      : input.history;
    const history: Content[] = historyRecords.flatMap((record) => {
      if (
        (record.type === 'user' ||
          record.type === 'assistant' ||
          (input.toolTurn && record.type === 'tool_result')) &&
        record.message?.parts
      ) {
        return [
          {
            role: record.type === 'assistant' ? 'model' : 'user',
            parts: record.message.parts,
          },
        ];
      }
      return [];
    });
    // Failed and cancelled turns have no assistant record, and curated
    // history drops an empty assistant record while keeping its prompt. Omit
    // both kinds of unanswered prompt even when later completed turns follow.
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
        args: { skill },
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
      const declarations =
        (await input.toolTurn?.declarations(input.signal)) ?? [];
      client
        .getChat()
        .setTools(
          declarations.length ? [{ functionDeclarations: declarations }] : [],
        );
      if (!preparedRecovery) {
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
                round === 0 && !pendingToolResults
                  ? SendMessageType.UserQuery
                  : SendMessageType.ToolResult,
              // Published deltas cannot be un-glued after the fact: a cut that
              // already delivered content replays the request, and the RETRY
              // handling below retracts the orphaned prefix (#13319).
              retractDeliveredOutputOnRetry: true,
              ...(input.prepareModel ? { onPreparedRequest: prepare } : {}),
            });
        preparedRecovery = undefined;
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
            throw new Error(parseAndFormatApiError(event.value.error));
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
