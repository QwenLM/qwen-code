/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import process from 'node:process';
import { parseBoolean } from '../config-service/features/gateParseUtils.js';
import {
  getPromptPolicySnapshot,
  PROMPT_SECTION_GATE_KEYS,
  type PromptPolicySnapshot,
  type PromptSectionGateKey,
} from '../config-service/features/promptPolicy.js';
import type { PromptBundle } from './types.js';
import {
  resolvePromptBehavior,
  type PromptBehaviorOverrides,
  type ResolvedCommunication,
} from './behavior-policy.js';

export const SIMPLE_SYSTEM_PROMPT_ENV = `${BRAND_FIXED_ENV_PREFIX}SIMPLE_SYSTEM_PROMPT`;

/** `undefined` 表示本地未覆盖，交由远端策略或默认值决定。 */
export type LocalPromptMode = PromptBundle | undefined;

export function resolveLocalPromptMode(
  raw: string | undefined,
): LocalPromptMode {
  const parsed = parseBoolean(raw);
  if (parsed === undefined) return undefined;
  return parsed ? 'lean' : 'full';
}

function resolveBundle(
  effectiveModel: string,
  localMode: LocalPromptMode,
  policy: PromptPolicySnapshot,
): PromptBundle {
  // 本地环境变量是开发/应急覆盖，显式值优先于远端策略。
  if (localMode !== undefined) return localMode;

  // Lean 是显式开启的新路径；未配置时回退到安全的 Full。
  return policy.bundleByModel[effectiveModel] ?? 'full';
}

/** Keep resolved behavior decisions alongside ordinary section gates. */
function resolveEnabledGates(
  policy: PromptPolicySnapshot,
  behavior: ReturnType<typeof resolvePromptBehavior>,
): readonly PromptSectionGateKey[] {
  // 保持 PROMPT_SECTION_GATE_KEYS 的声明顺序。
  return Object.freeze(
    PROMPT_SECTION_GATE_KEYS.filter((gate) => {
      if (gate === 'communication.turn_updates') {
        return behavior.communication.variant === 'turn_updates';
      }
      if (gate === 'behavior.autonomy') return behavior.autonomy;
      if (gate === 'behavior.act_dont_rederive') return behavior.actDontRederive;
      if (gate === 'behavior.delivering_work') return behavior.deliveringWork;
      return policy.sectionGates[gate] === 'enable';
    }),
  );
}

export interface ResolvedPromptPolicy {
  readonly bundle: PromptBundle;
  readonly enabledSectionGates: readonly PromptSectionGateKey[];
  readonly communication: ResolvedCommunication;
}

export function resolvePromptPolicy(options: {
  readonly effectiveModel: string;
  readonly localMode: LocalPromptMode;
  readonly policy: PromptPolicySnapshot;
  readonly behaviorOverrides?: PromptBehaviorOverrides;
}): ResolvedPromptPolicy {
  const bundle = resolveBundle(
    options.effectiveModel,
    options.localMode,
    options.policy,
  );
  const behavior = resolvePromptBehavior({
    effectiveModel: options.effectiveModel,
    bundle,
    policy: options.policy,
    overrides: options.behaviorOverrides,
  });
  return Object.freeze({
    bundle,
    communication: behavior.communication,
    enabledSectionGates: resolveEnabledGates(options.policy, behavior),
  });
}

/**
 * Resolves the bundle used by model-specific tool and Agent descriptions.
 *
 * Tool schemas are rendered later than the main system prompt, after model
 * routing has selected the effective model. Keep that path on the same local
 * override + remote policy contract instead of maintaining a second model
 * allowlist in the tool layer.
 */
export function resolvePromptBundleForModel(
  effectiveModel: string | undefined,
): PromptBundle {
  if (!effectiveModel) return 'full';

  return resolvePromptPolicy({
    effectiveModel,
    localMode: resolveLocalPromptMode(process.env[SIMPLE_SYSTEM_PROMPT_ENV]),
    policy: getPromptPolicySnapshot(),
  }).bundle;
}
