/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { createHash } from 'node:crypto';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';
import {
  HostedHookRecoveryRequiredError,
  type HostedHookSession,
  type HostedPromptHookRunner,
} from './hosted-hook-session.js';
import type { ManagedHookDispatcher } from '@qwen-code/qwen-code-core/hooks/hookEventHandler.js';
import type { ManagedHookModelScope } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
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

export interface HostedHarnessTextDeltas {
  delta(text: string): Promise<void>;
  /**
   * Retract the current message's published deltas so a restarted attempt
   * replaces them; a no-op when nothing is published (#13319).
   */
  retract(): Promise<void>;
}

export async function runHostedHarnessTextTurn(input: {
  sessionId: string;
  cwd: string;
  history: readonly ChatRecord[];
  prompt: string;
  promptId: string;
  signal: AbortSignal;
  resumeFromToolResults?: readonly Part[];
  hooks?: HostedHookSession;
  modelScope?: ManagedHookModelScope;
  toolTurn?: Pick<
    HostedWorkspaceToolTurn,
    'execute' | 'consumeResults' | 'declarations' | 'setPromptHookRunner'
  > &
    Partial<
      Pick<HostedWorkspaceToolTurn, 'resumeHookResults' | 'hookStopReason'>
    >;
  textDeltas?: HostedHarnessTextDeltas;
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
  let runPromptHook: HostedPromptHookRunner | undefined;
  let modelReady = false;
  let historyReady = false;
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
  if (!input.resumeFromToolResults)
    initialMessages.push({ role: 'user', parts: [{ text: input.prompt }] });
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
    await config.refreshAuth(authType, true);
    await input.modelScope?.bindBudget(config.getTurnBudget(), input.prompt);
    runPromptHook = input.modelScope
      ? createHostedPromptHookRunner(config, input.modelScope)
      : undefined;
    if (runPromptHook) input.toolTurn?.setPromptHookRunner?.(runPromptHook);
    modelReady = true;
    let effectivePrompt = input.prompt;
    if (input.hooks && !input.resumeFromToolResults) {
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
      entry?.role === 'model' && !!entry.parts?.some((part) => !!part.text);
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
      : [{ text: effectivePrompt }];
    let pendingToolResults = input.resumeFromToolResults !== undefined;
    let stopHookActive =
      (await input.hooks?.wasStopBlocked(input.promptId)) ?? false;
    for (let round = 0; round < 16; round++) {
      input.signal.throwIfAborted();
      if (input.hooks?.hasPendingOperations)
        throw new HostedHookRecoveryRequiredError();
      if (input.toolTurn?.hookStopReason) {
        const text = input.toolTurn.hookStopReason;
        return { text, parts: [{ text }], model: config.getModel() };
      }
      if (input.toolTurn)
        client.getChat().setTools([
          {
            functionDeclarations: await input.toolTurn.declarations(
              input.signal,
            ),
          },
        ]);
      let calls: ToolCallRequestInfo[] = [];
      let text = '';
      let finished = false;
      let modelFailure = true;
      const completeAttempt = await input.modelScope?.beginMainAttempt(
        config.getModel(),
      );
      const modelOccurrence =
        completeAttempt?.attemptId ?? `${input.promptId}:${round}`;
      const usage: unknown[] = [];
      try {
        for await (const event of client.sendMessageStream(
          request,
          input.signal,
          input.promptId,
          {
            type:
              round === 0 && !input.resumeFromToolResults
                ? SendMessageType.UserQuery
                : SendMessageType.ToolResult,
            // Published deltas cannot be un-glued after the fact: a cut that
            // already delivered content replays the request, and the RETRY
            // handling below retracts the orphaned prefix (#13319).
            retractDeliveredOutputOnRetry: true,
          },
        )) {
          if (event.type === LlmEventType.Content) {
            text += event.value;
            await textDeltas?.delta(event.value);
          } else if (event.type === LlmEventType.Finished) {
            finished = true;
            usage.push(event.value?.usageMetadata ?? null);
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
            throw new Error(event.value.error.message);
          } else if (event.type === LlmEventType.UserCancelled) {
            modelFailure = false;
            throw new Error('Hosted Harness turn was cancelled.');
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
      } catch (cause) {
        if (
          modelFailure &&
          !input.signal.aborted &&
          !(cause instanceof HostedHookRecoveryRequiredError)
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
        await completeAttempt?.(finished, usage);
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
      if (!input.toolTurn) return { text, model: config.getModel() };
      const output = client.getHistory().at(-1);
      if (output?.role !== 'model' || !output.parts)
        throw new Error('Hosted model output is unavailable.');
      const parts = structuredClone(output.parts);
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
    throw new Error('Hosted tool turn exceeded 16 model rounds.');
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
