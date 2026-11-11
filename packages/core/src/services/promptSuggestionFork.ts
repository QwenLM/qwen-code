/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Config } from '../config/config.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import type { Terminal } from '../core/query-event.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import type { GetModelPolicyResult } from '../core/model-policy.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import {
  getPromptSuggestionFeatureConfig,
  type PromptSuggestionMode,
} from '../config-service/features/promptSuggestion.js';

import { mergeModelConfig } from '../provider/model/modelConfig.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { runLogger } from '../utils/runLogger.js';

export interface PromptSuggestionForkSource {
  config: Config;
  snapshot: CacheSafeQuerySnapshot;
  isCurrent(): boolean;
  customContext?: Readonly<Record<string, string>>;
}

/** Hook-requested stops must not launch another prediction from the completed snapshot. */
export function canGeneratePromptSuggestionFork(
  terminal: Pick<Terminal, 'reason' | 'terminalDetail'>,
): boolean {
  return (
    terminal.reason === 'end_turn' && terminal.terminalDetail !== 'hook_stopped'
  );
}

/** Capture synchronously at turn completion, before hydration or yielding the SDK result. */
export function capturePromptSuggestionForkSource(
  config: Config,
  promptId: string,
  requestSetId: string,
  isCurrent: () => boolean,
  customContext?: Readonly<Record<string, string>>,
): PromptSuggestionForkSource | undefined {
  // The SDK captures before yielding its success frame. An optional suggestion
  // must never turn a completed foreground task into an error.
  try {
    const gate = getPromptSuggestionFeatureConfig();
    if (!gate.enabled || !gate.forkEnabled) return undefined;
    const snapshot = config.getCacheSafeQuerySnapshot?.();
    const sessionId = config.getSessionId();
    if (
      !snapshot?.lastAssistantUsage ||
      snapshot.completedTurn?.sessionId !== sessionId ||
      snapshot.completedTurn.promptId !== promptId ||
      snapshot.completedTurn.requestSetId !== requestSetId ||
      snapshot.forkContextMessages.at(-1)?.role !== 'assistant'
    )
      return undefined;
    const requestContext =
      snapshot.completedTurn.customContext ?? customContext;
    const state =
      snapshot.completedTurn.requestIdentity ??
      snapshot.completedTurn.predictionIdentity;
    if (!state) return undefined;
    return {
      config,
      snapshot,
      customContext: requestContext && { ...requestContext },
      isCurrent: () => {
        try {
          return (
            isCurrent() &&
            config.getCacheSafeQuerySnapshot?.() === snapshot &&
            config.getSessionId() === sessionId &&
            config.getModel() === state.model &&
            config.getModelRequestIdentity() === state.identity &&
            config.getPermissionMode() === state.permission
          );
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    runLogger.debug('[PromptSuggestion] Fork snapshot unavailable', { error });
    return undefined;
  }
}

// Validate once in the background, after the main result is available and
// before the request projection can repair gaps with synthetic tool results.
function hasCompleteToolHistory(snapshot: CacheSafeQuerySnapshot): boolean {
  const pending = new Set<string>();
  for (const message of snapshot.forkContextMessages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) return false;
      continue;
    }
    if (pending.size) return false;
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (pending.has(call.id)) return false;
        pending.add(call.id);
      }
    }
  }
  return pending.size === 0;
}

export async function generateForkSuggestion(
  source: PromptSuggestionForkSource,
  prompt: string,
  parentBusinessInfo: Readonly<BusinessInfo>,
  policy: GetModelPolicyResult | undefined,
  signal: AbortSignal,
  outputTokens: number,
  _promptMode: PromptSuggestionMode,
): Promise<string | null> {
  const { config, snapshot } = source;
  const parent = snapshot.modelResolution;
  const turn = snapshot.completedTurn;
  if (!turn || !source.isCurrent() || !hasCompleteToolHistory(snapshot))
    return null;
  // A different model can require different history projection (e.g. thinking
  // signatures or inline connection credentials). Never silently switch routes.
  if (policy?.model && policy.model !== parent.model.key) {
    runLogger.debug(
      '[PromptSuggestion] Skipped incompatible fork model policy',
    );
    return null;
  }
  const resolution = await raceWithAbortSignal(
    config.getModelProviderManager().select({
      purpose: 'suggestion',
      ...(turn.workdirs ? { workdirs: turn.workdirs } : {}),
      parentSelection: parent,
      overrideSelection: {
        model: parent.model,
        config: mergeModelConfig(parent.config, {
          context: {
            contextWindow: policy?.parameters?.contextWindow,
            maxOutputTokens: outputTokens,
          },
          reasoning: {
            effort: policy?.parameters?.reasoningEffort ?? 'none',
            thinking:
              policy?.parameters?.reasoningEffort &&
              policy.parameters.reasoningEffort !== 'none'
                ? { type: 'adaptive' }
                : { type: 'disabled' },
          },
        }),
      },
    }),
    signal,
  );
  if (
    !source.isCurrent() ||
    resolution.model.source !== parent.model.source ||
    resolution.model.key !== parent.model.key ||
    !resolution.config.context?.maxOutputTokens ||
    resolution.config.context.maxOutputTokens > outputTokens
  )
    return null;
  const result = await runForkedAgent({
    mode: 'singleRequest',
    querySource: 'prompt_suggestion',
    config,
    selection: resolution,
    parent: {
      ...snapshot,
      completedTurn: {
        ...turn,
        businessInfo: turn.businessInfo ?? parentBusinessInfo,
        customContext: turn.customContext ?? source.customContext,
      },
    },
    prompt,
    isCurrent: source.isCurrent,
    policyLabels: policy?.labels,
    signal,
  });
  return !signal.aborted && source.isCurrent() ? result.textContent : null;
}
