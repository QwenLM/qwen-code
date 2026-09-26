/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';

export interface HostedHarnessModelResult {
  text: string;
  model: string;
}

export async function runHostedHarnessTextTurn(input: {
  sessionId: string;
  cwd: string;
  history: readonly ChatRecord[];
  prompt: string;
  promptId: string;
  signal: AbortSignal;
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
    const history: Content[] = input.history.flatMap((record) => {
      if (
        (record.type === 'user' || record.type === 'assistant') &&
        record.message?.parts
      ) {
        return [
          {
            role: record.type === 'user' ? 'user' : 'model',
            parts: record.message.parts,
          },
        ];
      }
      return [];
    });
    // Failed and cancelled turns have no assistant record. Omit their
    // prompts even when later completed turns follow them in the journal.
    client
      .getChat()
      .setHistory(
        history.filter(
          (entry, index) =>
            entry.role !== 'user' || history[index + 1]?.role === 'model',
        ),
      );
    let text = '';
    let finished = false;
    for await (const event of client.sendMessageStream(
      [{ text: input.prompt }],
      input.signal,
      input.promptId,
    )) {
      if (event.type === LlmEventType.Content) text += event.value;
      else if (event.type === LlmEventType.Finished) finished = true;
      else if (
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
        event.type !== LlmEventType.Thought &&
        event.type !== LlmEventType.Citation &&
        event.type !== LlmEventType.Retry &&
        event.type !== LlmEventType.ModelFallback
      ) {
        throw new Error(
          'Hosted Harness model returned an unsupported continuation.',
        );
      }
    }
    if (!finished) throw new Error('Hosted Harness model turn did not finish.');
    return { text, model: config.getModel() };
  } finally {
    await config.shutdown({
      shutdownTelemetry: false,
      strictResourceCleanup: true,
    });
  }
}
