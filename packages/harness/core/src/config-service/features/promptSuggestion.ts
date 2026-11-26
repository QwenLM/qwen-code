/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../../utils/runLogger.js';
import {
  getConfigService,
  getConfigValue,
  subscribeConfigValue,
} from '../index.js';
import type { ConfigValueUnsubscribe } from '../config-service.js';
import {
  parseEnabledGateValue,
  parseObjectGateValue,
} from './gateParseUtils.js';

export const PROMPT_SUGGESTION_FEATURE_GATE = 'prompt_suggestion';
export type PromptSuggestionMode = 'legacy' | 'shared';

export interface PromptSuggestionFeatureConfig {
  readonly enabled: boolean;
  /** Selects the prediction prompt and output filters. */
  readonly mode: PromptSuggestionMode;
  /** Run the prediction on the completed parent turn instead of a summary. */
  readonly forkEnabled: boolean;
}

function parseGateValue(value: unknown): PromptSuggestionFeatureConfig {
  const record = parseObjectGateValue(value);
  // The initial fork rollout selected both shared rules and fork transport.
  const forkAlias = record?.['mode'] === 'fork';
  const rulesFlag = record?.['unifiedRulesEnabled'];
  // Keep existing mode-based rollouts working while clients migrate.
  const useUnifiedRules =
    typeof rulesFlag === 'boolean'
      ? rulesFlag
      : record?.['mode'] === 'shared' || forkAlias;
  // Missing rollout configuration must preserve existing recommendation behavior.
  return {
    enabled: parseEnabledGateValue(value) ?? true,
    mode: useUnifiedRules ? 'shared' : 'legacy',
    forkEnabled:
      record?.['forkEnabled'] === undefined
        ? forkAlias
        : record['forkEnabled'] === true,
  };
}

export function isPromptSuggestionPolicyCurrent(
  started: PromptSuggestionFeatureConfig,
  current: PromptSuggestionFeatureConfig,
): boolean {
  return (
    current.enabled &&
    current.mode === started.mode &&
    current.forkEnabled === started.forkEnabled
  );
}

export function getPromptSuggestionFeatureConfig(): PromptSuggestionFeatureConfig {
  return parseGateValue(getConfigValue(PROMPT_SUGGESTION_FEATURE_GATE));
}

export function isPromptSuggestionFeatureGateEnabled(): boolean {
  return getPromptSuggestionFeatureConfig().enabled;
}

export function subscribePromptSuggestionFeatureGate(
  listener: (config: PromptSuggestionFeatureConfig) => void,
): ConfigValueUnsubscribe | undefined {
  return getConfigService()?.onValueChange(
    PROMPT_SUGGESTION_FEATURE_GATE,
    (value) => listener(parseGateValue(value)),
  );
}

export function registerPromptSuggestionFeature(): void {
  subscribeConfigValue(PROMPT_SUGGESTION_FEATURE_GATE, (value) => {
    runLogger.log(
      '[config-service] prompt_suggestion feature gate value received',
      parseGateValue(value),
    );
  });
}
