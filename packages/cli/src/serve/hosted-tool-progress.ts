/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionEvent,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { readManagedMessageBody } from '@qwen-code/qwen-code-core/managed-runtime/managed-message-chunks.js';

export async function hostedToolProgress(
  session: Pick<ManagedSession, 'authority' | 'resources'>,
  event: ManagedSessionEvent,
  includeDetails = false,
): Promise<
  | {
      promptId: string;
      update: {
        sessionUpdate: 'tool_call' | 'tool_call_update';
        toolCallId: string;
        name: string;
        status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
        input?: Record<string, string | number>;
        output?: string;
        truncated?: boolean;
      };
    }
  | undefined
> {
  if (
    event.kind === 'message.committed' &&
    event.payload['role'] === 'tool_result'
  ) {
    const message = JSON.parse(
      (
        await readManagedMessageBody(
          (ref) => session.resources.read(ref),
          assertManagedSessionDurableRef(
            event.payload['contentRef'],
            'tool result',
          ),
        )
      ).toString('utf8'),
    ) as ChatRecord;
    const responses =
      message.message?.parts?.flatMap((part) =>
        part.functionResponse ? [part.functionResponse] : [],
      ) ?? [];
    const response = responses[0];
    if (
      responses.length !== 1 ||
      !response?.id ||
      !response.name ||
      !response.response ||
      !message.daemonPromptId
    )
      return;
    const status = terminalToolStatus(
      response.response?.['executionStatus'],
      response.response?.['error'],
    );
    if (!status) return;
    let args: Record<string, unknown> | undefined;
    if (includeDetails && supportsDetails(response.name)) {
      const batch = session.authority
        .eventsInSequenceRange(1, event.sequence - 1)
        .findLast(
          (entry) =>
            entry.kind === 'message.committed' &&
            entry.payload['role'] === 'assistant',
        );
      if (batch) {
        const assistant = JSON.parse(
          (
            await readManagedMessageBody(
              (ref) => session.resources.read(ref),
              assertManagedSessionDurableRef(
                batch.payload['contentRef'],
                'tool batch',
              ),
            )
          ).toString('utf8'),
        ) as ChatRecord;
        if (assistant.daemonPromptId === message.daemonPromptId) {
          args = assistant.message?.parts?.find(
            (part) =>
              part.functionCall?.id === response.id &&
              part.functionCall?.name === response.name,
          )?.functionCall?.args;
        }
      }
    }
    return {
      promptId: message.daemonPromptId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: response.id,
        name: response.name,
        status,
        ...(includeDetails
          ? inlineDetails(response.name, args, response.response)
          : {}),
      },
    };
  }
  if (event.kind !== 'tool.intent' && event.kind !== 'tool.receipt') return;
  const events = session.authority.eventsInSequenceRange(1, event.sequence);
  const intent =
    event.kind === 'tool.intent'
      ? event
      : events.findLast(
          (entry) =>
            entry.kind === 'tool.intent' &&
            entry.sequence < event.sequence &&
            entry.payload['executionCallId'] ===
              event.payload['executionCallId'],
        );
  if (!intent) return;
  const batch = events.find(
    (entry) =>
      entry.kind === 'message.committed' &&
      entry.sequence < intent.sequence &&
      entry.payload['role'] === 'assistant' &&
      entry.payload['messageId'] === intent.payload['batchId'],
  );
  const ordinal = intent.payload['ordinal'];
  if (
    !batch ||
    typeof ordinal !== 'number' ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  )
    return;
  const message = JSON.parse(
    (
      await readManagedMessageBody(
        (ref) => session.resources.read(ref),
        assertManagedSessionDurableRef(
          batch.payload['contentRef'],
          'tool batch',
        ),
      )
    ).toString('utf8'),
  ) as ChatRecord;
  const call = message.message?.parts?.filter((part) => part.functionCall)[
    ordinal
  ]?.functionCall;
  if (!call?.id || !call.name || !message.daemonPromptId) return;
  let status: 'in_progress' | 'completed' | 'failed' | 'cancelled' =
    'in_progress';
  if (event.kind === 'tool.receipt') {
    const outcome = JSON.parse(
      (
        await session.resources.read(
          assertManagedSessionDurableRef(
            event.payload['toolOutcomeRef'],
            'tool outcome',
          ),
        )
      ).toString('utf8'),
    ) as {
      envelope?: { executionStatus?: string };
      executionStatus?: string;
      functionResponse?: {
        response?: { executionStatus?: string; error?: unknown };
      };
    };
    const response = outcome.functionResponse?.response;
    const executionStatus =
      outcome.envelope?.executionStatus ??
      outcome.executionStatus ??
      response?.executionStatus;
    if (executionStatus === undefined && !response) return;
    const terminal = terminalToolStatus(executionStatus, response?.error);
    if (!terminal) return;
    status = terminal;
  }
  // These are private transport fields. Java applies its explicit inline
  // publication policy before persisting them in public events and Items.
  return {
    promptId: message.daemonPromptId,
    update: {
      sessionUpdate:
        event.kind === 'tool.intent' ? 'tool_call' : 'tool_call_update',
      toolCallId: call.id,
      name: call.name,
      status,
      ...(includeDetails ? inlineDetails(call.name, call.args) : {}),
    },
  };
}

function supportsDetails(name: string) {
  return name === 'read_file' || name === 'run_shell_command';
}

function inlineDetails(
  name: string,
  args?: Record<string, unknown>,
  response?: Record<string, unknown>,
) {
  if (!supportsDetails(name)) return {};
  const input: Record<string, string | number> = {};
  const keys =
    name === 'read_file'
      ? ['file_path', 'path', 'offset', 'limit']
      : ['command', 'directory', 'timeout'];
  for (const key of keys) {
    const value = args?.[key];
    const numeric = ['timeout', 'offset', 'limit'].includes(key);
    if (
      (!numeric && typeof value === 'string') ||
      (numeric && typeof value === 'number' && Number.isFinite(value))
    )
      input[key] = value;
  }
  let truncated = false;
  if (Buffer.byteLength(JSON.stringify(input)) > 4096) {
    for (const key of keys) {
      if (typeof input[key] === 'string')
        input[key] = boundedText(input[key], 1024).text;
    }
    truncated = true;
  }
  const output =
    typeof response?.['output'] === 'string' ? response['output'] : undefined;
  const error =
    typeof response?.['error'] === 'string' ? response['error'] : undefined;
  const text = error ? (output ? `${output}\n\n${error}` : error) : output;
  const preview = text === undefined ? undefined : boundedText(text, 8192);
  return {
    ...(Object.keys(input).length ? { input } : {}),
    ...(preview ? { output: preview.text } : {}),
    ...(truncated ||
    preview?.truncated ||
    response?.['previewTruncated'] === true
      ? { truncated: true }
      : {}),
  };
}

function boundedText(text: string, limit: number) {
  let bytes = 2;
  let length = 0;
  for (const char of text) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > limit) break;
    bytes += size;
    length += char.length;
  }
  return { text: text.slice(0, length), truncated: length < text.length };
}

function terminalToolStatus(status: unknown, error: unknown) {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'success') return 'completed';
  if (status === 'error' || status === 'not_started') return 'failed';
  if (status === undefined) return error ? 'failed' : 'completed';
  return undefined;
}
