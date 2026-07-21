/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { parseAcpModelOption } from '../utils/acpModelUtils.js';

/**
 * A resolved toggle target: the bare model id plus the auth type that owns it.
 */
export interface ResolvedToggleTarget {
  modelId: string;
  authType: AuthType;
}

/**
 * The subset of Config needed to resolve which provider owns a toggle model.
 */
export interface ToggleModelProviderLookup {
  getAvailableModelsForAuthType(authType: AuthType): Array<{ id: string }>;
}

function hasModel(
  config: ToggleModelProviderLookup,
  authType: AuthType,
  modelId: string,
): boolean {
  return config
    .getAvailableModelsForAuthType(authType)
    .some((model) => model.id === modelId);
}

/**
 * Resolve the auth type to use when toggling to `toggleSpec`.
 *
 * The configured `model.toggleModel` may be a bare model id or a
 * provider-qualified `id(authType)` string (the same format the `/model`
 * command accepts, where `authType` is an AuthType value such as `openai`). A
 * cross-provider toggle must pass the *target* model's auth type to
 * `Config.switchModel` — passing the current auth type makes the registry
 * lookup fail or sends the request to the wrong endpoint/credentials.
 *
 * Resolution order:
 * 1. An explicit `id(authType)` suffix wins.
 * 2. The current auth type, when it already owns the model id — preserves the
 *    existing same-provider behavior exactly (no auth-type change).
 * 3. The first other configured provider that owns the model id — enables
 *    unqualified cross-provider toggles.
 * 4. Fall back to the current auth type; `switchModel` then surfaces a clear
 *    "model not found" error to the user.
 */
export function resolveToggleTarget(
  config: ToggleModelProviderLookup,
  toggleSpec: string,
  currentAuthType: AuthType,
): ResolvedToggleTarget {
  const parsed = parseAcpModelOption(toggleSpec);
  if (parsed.authType) {
    return { modelId: parsed.modelId, authType: parsed.authType };
  }

  const modelId = parsed.modelId;
  if (hasModel(config, currentAuthType, modelId)) {
    return { modelId, authType: currentAuthType };
  }
  for (const authType of Object.values(AuthType)) {
    if (authType !== currentAuthType && hasModel(config, authType, modelId)) {
      return { modelId, authType };
    }
  }
  return { modelId, authType: currentAuthType };
}

/**
 * A snapshot of the model to return to on a backward toggle.
 */
export interface TogglePreviousModel {
  modelId: string;
  authType: AuthType;
}

/**
 * The action the toggle handler should perform, computed purely from state.
 */
export type ToggleAction =
  | { type: 'no-auth' }
  | { type: 'already-on'; modelId: string }
  | {
      type: 'forward';
      target: ResolvedToggleTarget;
      previous: TogglePreviousModel;
    }
  | { type: 'backward'; previous: TogglePreviousModel };

/**
 * Decide what the Ctrl+F toggle should do given the current state.
 *
 * Pure: no side effects, no config calls — the handler in AppContainer
 * executes the returned action (switchModel, history messages, ref updates).
 */
export function computeToggleAction(
  currentModel: string,
  currentAuthType: AuthType | undefined,
  target: ResolvedToggleTarget,
  previousModel: TogglePreviousModel | null,
): ToggleAction {
  if (!currentAuthType) {
    return { type: 'no-auth' };
  }
  const alreadyOnTarget =
    currentModel === target.modelId && currentAuthType === target.authType;
  if (alreadyOnTarget) {
    if (previousModel) {
      return { type: 'backward', previous: previousModel };
    }
    return { type: 'already-on', modelId: target.modelId };
  }
  return {
    type: 'forward',
    target,
    previous: { modelId: currentModel, authType: currentAuthType },
  };
}

/**
 * Whether a switch into `targetAuthType` from `currentAuthType` requires
 * cached Qwen OAuth credentials (mirrors the `/model` command's logic).
 */
export function needsCachedCredentials(
  targetAuthType: AuthType,
  currentAuthType: AuthType,
): boolean {
  return (
    targetAuthType !== currentAuthType && targetAuthType === AuthType.QWEN_OAUTH
  );
}
