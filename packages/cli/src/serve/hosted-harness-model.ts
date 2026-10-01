/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

import type { HostedWorkspaceToolTurn } from './hosted-workspace-tool-turn.js';

export interface HostedHarnessModelResult {
  text: string;
  parts?: Part[];
  model: string;
}

export async function runHostedHarnessTextTurn(input: {
  sessionId: string;
  cwd: string;
  history: readonly ChatRecord[];
  prompt: string;
  promptId: string;
  signal: AbortSignal;
  resumeFromToolResults?: readonly Part[];
  toolTurn?: Pick<
    HostedWorkspaceToolTurn,
    'execute' | 'consumeResults' | 'declarations'
  >;
  workspaceContext?: { read(): string | undefined };
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
  try {
    await config.initialize({
      signal: input.signal,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
    });
    const authType = config.getModelsConfig().getCurrentAuthType();
    if (!authType)
      throw new Error('Hosted Harness model authentication is unavailable.');
    await config.refreshAuth(authType, true);
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
    // the context slot instead of the Harness host's filesystem. getUserMemory
    // is read per request, so a fetch that lands during the first tool batch
    // reaches the very next request.
    let injectedContext: string | undefined;
    const contextNow = input.workspaceContext?.read();
    if (contextNow) {
      config.setUserMemory(contextNow);
      injectedContext = contextNow;
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
    let request: Part[] = input.resumeFromToolResults
      ? [...input.resumeFromToolResults]
      : [{ text: input.prompt }];
    for (let round = 0; round < 16; round++) {
      input.signal.throwIfAborted();
      const contextAvailable = input.workspaceContext?.read();
      if (contextAvailable && contextAvailable !== injectedContext) {
        config.setUserMemory(contextAvailable);
        injectedContext = contextAvailable;
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
      for await (const event of client.sendMessageStream(
        request,
        input.signal,
        input.promptId,
        {
          type:
            round === 0 && !input.resumeFromToolResults
              ? SendMessageType.UserQuery
              : SendMessageType.ToolResult,
        },
      )) {
        if (event.type === LlmEventType.Content) text += event.value;
        else if (event.type === LlmEventType.Finished) finished = true;
        else if (event.type === LlmEventType.Retry) {
          calls = [];
          if (!event.isContinuation) text = '';
        } else if (event.type === LlmEventType.ModelFallback) {
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
          throw new Error('Hosted Harness no-tool turn refused a tool call.');
        } else if (event.type === LlmEventType.Error) {
          throw new Error(event.value.error.message);
        } else if (event.type === LlmEventType.UserCancelled) {
          throw new Error('Hosted Harness turn was cancelled.');
        } else if (
          event.type !== LlmEventType.ChatCompressed &&
          event.type !== LlmEventType.Thought &&
          event.type !== LlmEventType.Citation
        ) {
          throw new Error(
            'Hosted Harness model returned an unsupported continuation.',
          );
        }
      }
      if (!finished)
        throw new Error('Hosted Harness model turn did not finish.');
      if (!input.toolTurn) return { text, model: config.getModel() };
      if (round > 0 || input.resumeFromToolResults)
        await input.toolTurn.consumeResults();
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
      if (calls.length === 0) return { text, parts, model: config.getModel() };
      request = await input.toolTurn.execute(
        calls,
        parts,
        config.getModel(),
        input.signal,
      );
    }
    throw new Error('Hosted tool turn exceeded 16 model rounds.');
  } finally {
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
