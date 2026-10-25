/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type {
  ChatRecordingService,
  RecordToolResultOptions,
} from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { getLastApiHistoryPromptId } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import type { LlmChat } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { getToolCallFingerprint } from '@qwen-code/qwen-code-core/core/toolCallIdUtils.js';
import { canonicalToolName } from '@qwen-code/qwen-code-core/tools/tool-names.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/utils/api-history-metadata.js';

export interface RestoreToolResponseDurability {
  readonly recorder: ChatRecordingService;
  readonly truncatedCount: number;
  readonly promptId?: string;
}

export interface RestoreToolResponseCompletion {
  toolCallResult: Parameters<
    ChatRecordingService['restoreToolBranch']
  >[0]['toolCallResult'];
  options?: RecordToolResultOptions;
}

export interface RestoreToolResponseBinding {
  completionStarted: boolean;
  executionCallId?: string;
  readonly durability?: RestoreToolResponseDurability;
  readonly config: Config;
  readonly client: LlmClient;
  readonly chat: LlmChat;
  readonly sessionId: string;
  readonly revision: number;
  readonly tail: Content;
  readonly length: number;
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly fingerprint: string;
  readonly executionFingerprint: string;
  readonly promptId: string | undefined;
}

const fingerprint = (name: string, args: unknown) =>
  getToolCallFingerprint(canonicalToolName(name), args);

export function selectRestoreCheckpointCall(
  history: readonly Content[],
  toolName: string,
  originalCallId?: string,
) {
  const tail = history.at(-1);
  const calls =
    tail?.role === 'model'
      ? (tail.parts ?? []).flatMap((part) =>
          part.functionCall ? [part.functionCall] : [],
        )
      : [];
  if (calls.length === 0) return;
  const named = calls.filter(
    (call) =>
      typeof call.name === 'string' &&
      canonicalToolName(call.name) === canonicalToolName(toolName),
  );
  // Older checkpoints lack a call ID and can contain hook-modified execution
  // arguments, even matching a sibling. Parameter equality cannot prove identity.
  const matches = originalCallId
    ? named.filter((call) => call.id === originalCallId)
    : named;
  if (matches.length !== 1 || !matches[0].id || !matches[0].name)
    throw new Error('Checkpoint does not identify one pending tool call.');
  const call = matches[0];
  const occurrences = history.flatMap((content) =>
    (content.parts ?? []).filter((part) => part.functionCall?.id === call.id),
  );
  if (
    occurrences.length !== 1 ||
    history.some((content) =>
      content.parts?.some((part) => part.functionResponse?.id === call.id),
    )
  )
    throw new Error(
      'Checkpoint tool call identity is already paired or ambiguous.',
    );
  return {
    callId: call.id!,
    name: call.name!,
    args: structuredClone(call.args ?? {}),
    promptId:
      getApiHistoryPromptId(tail!) ?? getLastApiHistoryPromptId(history),
  };
}

export function createRestoreToolResponseBinding(
  config: Config,
  toolName: string,
  toolArgs: Record<string, unknown>,
  durability?: RestoreToolResponseDurability,
  originalCallId?: string,
): RestoreToolResponseBinding | undefined {
  const client = config.getLlmClient();
  const chat = client.getChat();
  const selected = selectRestoreCheckpointCall(
    client.getHistoryShallow(),
    toolName,
    originalCallId,
  );
  if (!selected) return;
  const tail = chat.peekLastHistoryEntry()!;
  return {
    config,
    client,
    chat,
    completionStarted: false,
    durability,
    sessionId: config.getSessionId(),
    revision: chat.getHistoryReplacementRevision(),
    tail,
    length: chat.getHistoryLength(),
    callId: selected.callId,
    name: selected.name,
    args: selected.args,
    fingerprint: fingerprint(selected.name, selected.args),
    executionFingerprint: fingerprint(toolName, toolArgs),
    promptId: selected.promptId ?? durability?.promptId,
  };
}

export function isRestoreToolResponseBindingCurrent(
  binding: RestoreToolResponseBinding,
): boolean {
  const { config, client, chat } = binding;
  const calls = (binding.tail.parts ?? [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []))
    .filter((call) => call.id === binding.callId);
  if (
    calls.length !== 1 ||
    typeof calls[0].name !== 'string' ||
    fingerprint(calls[0].name, calls[0].args) !== binding.fingerprint
  )
    return false;
  return (
    (!binding.durability ||
      config.getChatRecordingService() === binding.durability.recorder) &&
    config.getSessionId() === binding.sessionId &&
    config.getLlmClient() === client &&
    client.getChat() === chat &&
    chat.getHistoryReplacementRevision() === binding.revision &&
    chat.peekLastHistoryEntry() === binding.tail &&
    chat.getHistoryLength() === binding.length &&
    !client.getHistoryFunctionResponseIds().has(binding.callId)
  );
}

export async function completeRestoreToolResponse(
  binding: RestoreToolResponseBinding,
  execution: Pick<ToolCallRequestInfo, 'callId' | 'name' | 'args'>,
  responseParts: readonly Part[],
  isCurrent: () => boolean,
  completion?: RestoreToolResponseCompletion,
): Promise<boolean> {
  const { client } = binding;
  if (
    binding.completionStarted ||
    !isCurrent() ||
    canonicalToolName(execution.name) !== canonicalToolName(binding.name) ||
    (binding.executionCallId !== undefined
      ? execution.callId !== binding.executionCallId
      : fingerprint(execution.name, execution.args) !==
        binding.executionFingerprint) ||
    !isRestoreToolResponseBindingCurrent(binding)
  )
    return false;
  const responses = responseParts.filter((part) => part.functionResponse);
  if (
    responses.length !== 1 ||
    responses[0].functionResponse?.id !== execution.callId ||
    typeof responses[0].functionResponse.name !== 'string' ||
    canonicalToolName(responses[0].functionResponse.name) !==
      canonicalToolName(binding.name)
  )
    return false;
  binding.completionStarted = true;
  if (binding.durability) {
    if (!completion)
      throw new Error('Restore completion is missing real execution metadata.');
    const { recorder, truncatedCount } = binding.durability;
    const survivingFileHistorySnapshots = structuredClone(
      binding.config.getFileHistoryService().getSnapshots(),
    );
    const published = await recorder.restoreToolBranch({
      sessionId: binding.sessionId,
      originalCallId: binding.callId,
      name: binding.name,
      args: binding.args,
      promptId: binding.promptId,
      execution,
      responseParts,
      toolCallResult: completion.toolCallResult,
      options: completion.options,
      truncatedCount,
      survivingFileHistorySnapshots,
      isCurrent: () =>
        isCurrent() && isRestoreToolResponseBindingCurrent(binding),
    });
    if (
      !published ||
      !isCurrent() ||
      !isRestoreToolResponseBindingCurrent(binding)
    )
      return false;
  }
  const content: Content = {
    role: 'user',
    parts: responseParts.map((part) =>
      part.functionResponse
        ? {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              id: binding.callId,
              name: binding.name,
            },
          }
        : { ...part },
    ),
  };
  markApiHistoryPrompt(content, binding.promptId);
  // addHistory appends synchronously, before its Promise is returned.
  await client.addHistory(content);
  return true;
}
