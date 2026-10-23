/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
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

export interface RestoreToolResponseBinding {
  readonly config: Config;
  readonly client: LlmClient;
  readonly chat: LlmChat;
  readonly sessionId: string;
  readonly revision: number;
  readonly tail: Content;
  readonly length: number;
  readonly callId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly promptId: string | undefined;
}

const fingerprint = (name: string, args: unknown) =>
  getToolCallFingerprint(canonicalToolName(name), args);

export function createRestoreToolResponseBinding(
  config: Config,
  toolName: string,
  toolArgs: Record<string, unknown>,
): RestoreToolResponseBinding | undefined {
  const client = config.getLlmClient();
  const chat = client.getChat();
  const tail = chat.peekLastHistoryEntry();
  const calls =
    tail?.role === 'model'
      ? (tail.parts ?? []).flatMap((part) =>
          part.functionCall ? [part.functionCall] : [],
        )
      : [];
  if (!tail || calls.length === 0) return;
  const expected = fingerprint(toolName, toolArgs);
  const matches = calls.filter(
    (call) =>
      typeof call.name === 'string' &&
      fingerprint(call.name, call.args) === expected,
  );
  if (matches.length !== 1 || !matches[0].id || !matches[0].name)
    throw new Error('Checkpoint does not identify one pending tool call.');
  const call = matches[0];
  const id = call.id!;
  const occurrences = client
    .getHistoryShallow()
    .flatMap((content) =>
      (content.parts ?? []).filter((part) => part.functionCall?.id === id),
    );
  if (
    occurrences.length !== 1 ||
    client.getHistoryFunctionResponseIds().has(id)
  )
    throw new Error(
      'Checkpoint tool call identity is already paired or ambiguous.',
    );
  return {
    config,
    client,
    chat,
    sessionId: config.getSessionId(),
    revision: chat.getHistoryReplacementRevision(),
    tail,
    length: chat.getHistoryLength(),
    callId: id,
    name: call.name!,
    fingerprint: expected,
    promptId: getApiHistoryPromptId(tail),
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
): Promise<boolean> {
  const { client } = binding;
  if (
    !isCurrent() ||
    fingerprint(execution.name, execution.args) !== binding.fingerprint ||
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
