/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import { MAX_CRON_TASK_ROUTING_ID_LENGTH } from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import type { AcpSessionBridge } from './bridgeTypes.js';

export interface SessionStartupConfig {
  modelServiceId: string;
  reasoningEffort?: ReasoningEffort | 'default' | 'none';
}

export interface SessionStartupConfigApplied extends SessionStartupConfig {
  effectiveReasoning?:
    | { state: 'enabled'; effort?: ReasoningEffort }
    | { state: 'disabled' }
    | { state: 'provider-default' };
}

export class SessionStartupConfigError extends Error {
  override readonly name = 'SessionStartupConfigError';

  constructor(
    readonly code: 'invalid_startup_config' | 'startup_config_rejected',
    message: string,
    /**
     * The session the rejected selection was applied to. Present on
     * `startup_config_rejected` so a caller that never supplied an id (or
     * whose id the child did not honor) can still name the orphaned
     * recording for rollback; absent on `invalid_startup_config`, which is
     * raised before any session exists.
     */
    readonly sessionId?: string,
  ) {
    super(message);
  }
}

export function isSessionStartupConfigError(
  error: unknown,
): error is Pick<SessionStartupConfigError, 'code' | 'message' | 'sessionId'> {
  // Split bundles can load distinct constructors for the same error contract.
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'invalid_startup_config' ||
      error.code === 'startup_config_rejected') &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function isReasoningSelection(
  value: unknown,
): value is NonNullable<SessionStartupConfig['reasoningEffort']> {
  return (
    typeof value === 'string' &&
    (value === 'default' ||
      value === 'none' ||
      REASONING_EFFORT_TIERS.some((tier) => tier === value))
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
    config.modelServiceId.length > MAX_CRON_TASK_ROUTING_ID_LENGTH ||
    (config.reasoningEffort !== undefined &&
      !isReasoningSelection(config.reasoningEffort)) ||
    request.modelServiceId !== undefined ||
    request.sessionScope === 'single'
  ) {
    throw new SessionStartupConfigError(
      'invalid_startup_config',
      'startupConfig requires modelServiceId (1-256 characters) and an optional valid reasoningEffort, without unknown fields, a legacy modelServiceId or single session scope.',
    );
  }
  return {
    modelServiceId: config.modelServiceId.trim(),
    ...(config.reasoningEffort !== undefined
      ? { reasoningEffort: config.reasoningEffort }
      : {}),
  };
}

function rejectInvalidSelection(error: unknown, sessionId: string): never {
  if (
    error === null ||
    typeof error !== 'object' ||
    !('code' in error) ||
    !('message' in error) ||
    typeof error.message !== 'string'
  ) {
    throw error;
  }
  // Only a deterministic parameter rejection is a definite, client-caused
  // refusal: the child maps its own caller-caused setter refusals (an
  // unknown or media-only primary model, an unsupported effort) to
  // invalidParams. Internal errors (-32603) also carry auth, credential,
  // timeout and transport failures — uncertain outcomes that stay unmapped.
  if (error.code === -32602) {
    throw new SessionStartupConfigError(
      'startup_config_rejected',
      error.message,
      sessionId,
    );
  }
  throw error;
}

export async function applySessionStartupConfig(
  bridge: Pick<AcpSessionBridge, 'setSessionConfigOption'>,
  sessionId: string,
  config: SessionStartupConfig,
): Promise<SessionStartupConfigApplied> {
  const model = await bridge
    .setSessionConfigOption(sessionId, {
      sessionId,
      configId: 'model',
      value: config.modelServiceId,
    })
    .catch((error: unknown) => rejectInvalidSelection(error, sessionId));
  const modelServiceId = model.configOptions?.find(
    (option) => option.id === 'model',
  )?.currentValue;
  if (!modelServiceId) {
    throw new SessionStartupConfigError(
      'startup_config_rejected',
      'The session did not confirm its model selection.',
      sessionId,
    );
  }
  if (config.reasoningEffort === undefined) return { modelServiceId };
  const result = await bridge
    .setSessionConfigOption(sessionId, {
      sessionId,
      configId: 'reasoning_effort',
      value: config.reasoningEffort,
    })
    .catch((error: unknown) => rejectInvalidSelection(error, sessionId));
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
      sessionId,
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
