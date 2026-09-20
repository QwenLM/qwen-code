/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from './bridgeTypes.js';

export interface SessionStartupConfig {
  modelServiceId: string;
  reasoningEffort: ReasoningEffort | 'default' | 'none';
}

export interface SessionStartupConfigApplied extends SessionStartupConfig {
  effectiveReasoning:
    | { state: 'enabled'; effort?: ReasoningEffort }
    | { state: 'disabled' }
    | { state: 'provider-default' };
}

export class SessionStartupConfigError extends Error {
  override readonly name = 'SessionStartupConfigError';

  constructor(
    readonly code: 'invalid_startup_config' | 'startup_config_rejected',
    message: string,
  ) {
    super(message);
  }
}

function isReasoningSelection(
  value: unknown,
): value is SessionStartupConfig['reasoningEffort'] {
  return (
    typeof value === 'string' &&
    ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
  );
}

export function parseSessionStartupConfig(
  value: unknown,
  request: { modelServiceId?: unknown; sessionScope?: unknown } = {},
): SessionStartupConfig | undefined {
  if (value === undefined) return undefined;
  const config = value as Partial<SessionStartupConfig> | null;
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) => key !== 'modelServiceId' && key !== 'reasoningEffort',
    ) ||
    typeof config.modelServiceId !== 'string' ||
    !config.modelServiceId.trim() ||
    !isReasoningSelection(config.reasoningEffort) ||
    request.modelServiceId !== undefined ||
    request.sessionScope === 'single'
  ) {
    throw new SessionStartupConfigError(
      'invalid_startup_config',
      'startupConfig requires modelServiceId and reasoningEffort, without unknown fields, a legacy modelServiceId or single session scope.',
    );
  }
  return {
    modelServiceId: config.modelServiceId.trim(),
    reasoningEffort: config.reasoningEffort,
  };
}

export async function applySessionStartupConfig(
  bridge: Pick<AcpSessionBridge, 'setSessionConfigOption'>,
  sessionId: string,
  config: SessionStartupConfig,
): Promise<SessionStartupConfigApplied> {
  const model = await bridge.setSessionConfigOption(sessionId, {
    sessionId,
    configId: 'model',
    value: config.modelServiceId,
  });
  const modelServiceId = model.configOptions?.find(
    (option) => option.id === 'model',
  )?.currentValue;
  if (!modelServiceId) {
    throw new SessionStartupConfigError(
      'startup_config_rejected',
      'The session did not confirm its model selection.',
    );
  }
  const result = await bridge.setSessionConfigOption(sessionId, {
    sessionId,
    configId: 'reasoning_effort',
    value: config.reasoningEffort,
  });
  const reasoning = result.configOptions?.find(
    (option) => option.id === 'reasoning_effort',
  );
  const currentModel = result.configOptions?.find(
    (option) => option.id === 'model',
  )?.currentValue;
  const selection = reasoning?.currentValue;
  if (
    currentModel !== modelServiceId ||
    !isReasoningSelection(selection) ||
    (config.reasoningEffort !== 'default' &&
      selection !== config.reasoningEffort)
  ) {
    throw new SessionStartupConfigError(
      'startup_config_rejected',
      'The session did not confirm its model and reasoning selection.',
    );
  }
  const meta = reasoning?._meta?.['qwenCode/reasoning'];
  const toggleOnly =
    meta !== null &&
    typeof meta === 'object' &&
    'toggleOnly' in meta &&
    meta.toggleOnly === true;
  return {
    modelServiceId,
    reasoningEffort: config.reasoningEffort,
    effectiveReasoning:
      selection === 'none'
        ? { state: 'disabled' }
        : selection === 'default'
          ? toggleOnly
            ? { state: 'enabled' }
            : { state: 'provider-default' }
          : { state: 'enabled', effort: selection },
  };
}
