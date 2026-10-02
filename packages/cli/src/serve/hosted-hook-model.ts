/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ContentGenerator } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { PromptHookRunner } from '@qwen-code/qwen-code-core/hooks/promptHookRunner.js';
import type { ManagedHookModelScope } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-activation.js';
import { loadCliConfig, type CliArgs } from '../config/config.js';
import { loadSettings } from '../config/settings.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import type { HostedPromptHookRunner } from './hosted-hook-session.js';

function validateResponse(response: GenerateContentResponse): void {
  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  const json = text?.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const result: unknown = JSON.parse(json ?? '');
  if (
    !result ||
    typeof result !== 'object' ||
    !('ok' in result) ||
    typeof result.ok !== 'boolean' ||
    ('reason' in result && typeof result.reason !== 'string') ||
    ('additionalContext' in result &&
      typeof result.additionalContext !== 'string')
  ) {
    throw new Error('Hosted prompt Hook returned an invalid decision.');
  }
}

export function createHostedPromptHookRunner(
  config: Config,
  scope: ManagedHookModelScope,
): HostedPromptHookRunner {
  return async (hookConfig, eventName, input, signal) => {
    const operationId =
      'managed_hook_execution_id' in input
        ? input.managed_hook_execution_id
        : undefined;
    const occurrenceId =
      'managed_hook_occurrence_id' in input
        ? input.managed_hook_occurrence_id
        : undefined;
    const originTurnId =
      'managed_hook_origin_turn_id' in input
        ? input.managed_hook_origin_turn_id
        : undefined;
    if (
      typeof operationId !== 'string' ||
      typeof occurrenceId !== 'string' ||
      (originTurnId !== null && typeof originTurnId !== 'string')
    ) {
      throw new Error('Hosted prompt Hook is missing its committed identity.');
    }
    return scope.evaluate(
      {
        operationId,
        occurrenceId,
        originTurnId,
        eventName,
        model: hookConfig.model ?? config.getModel(),
      },
      async (recordUsage) => {
        const pending: Array<Promise<GenerateContentResponse>> = [];
        const wrap = (generator: ContentGenerator): ContentGenerator => ({
          generateContent(request) {
            const response = generator.generateContent(request, operationId);
            pending.push(response);
            return response.then((result) => {
              recordUsage({
                model: request.model,
                usage: result.usageMetadata ?? null,
              });
              validateResponse(result);
              return result;
            });
          },
          generateContentStream:
            generator.generateContentStream.bind(generator),
          embedContent: generator.embedContent.bind(generator),
        });
        const hooked = new Proxy(config, {
          get(target, property) {
            if (property === 'getContentGenerator') {
              return () => wrap(target.getContentGenerator());
            }
            if (property === 'getBaseLlmClient') {
              return () => ({
                async resolveForModel(
                  ...args: Parameters<
                    ReturnType<Config['getBaseLlmClient']>['resolveForModel']
                  >
                ) {
                  const resolved = await target
                    .getBaseLlmClient()
                    .resolveForModel(...args);
                  return {
                    ...resolved,
                    contentGenerator: wrap(resolved.contentGenerator),
                  };
                },
              });
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        try {
          return await new PromptHookRunner(hooked).execute(
            hookConfig,
            eventName,
            input,
            signal,
          );
        } finally {
          // A timeout requests cancellation; the slot stays held until the
          // provider promise settles, including providers that ignore abort.
          await Promise.allSettled(pending);
        }
      },
    );
  };
}

export async function runHostedHookOperation<T>(
  input: {
    sessionId: string;
    cwd: string;
    signal: AbortSignal;
    scope: ManagedHookModelScope;
  },
  run: (runner: HostedPromptHookRunner) => Promise<T>,
): Promise<T> {
  const settings = loadSettings(input.cwd, {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: false,
  });
  const config = await loadCliConfig(
    settings.merged,
    {
      acp: true,
      safeMode: true,
      chatRecording: false,
      sessionId: input.sessionId,
    } as CliArgs,
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
      throw new Error('Hosted Hook model authentication is unavailable.');
    await config.refreshAuth(authType, true);
    await input.scope.bindBudget(config.getTurnBudget());
    return await run(createHostedPromptHookRunner(config, input.scope));
  } finally {
    try {
      await config.shutdown({
        shutdownTelemetry: false,
        strictResourceCleanup: true,
      });
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: Hosted Hook model cleanup failed: ${String(cause)}`,
      );
    }
  }
}
