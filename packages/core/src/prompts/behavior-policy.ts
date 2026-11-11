/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import { parseBoolean } from '../config-service/features/gateParseUtils.js';
import type {
  PromptPolicySnapshot,
  RemoteSectionMode,
} from '../config-service/features/promptPolicy.js';
import type { PromptBundle } from './types.js';

export type CommunicationVariant =
  | 'turn_updates'
  | 'outcome_first'
  | 'code_style'
  | 'standard';

export interface ResolvedCommunication {
  readonly variant: CommunicationVariant;
  readonly finalMessageRequired: boolean;
}

export interface PromptBehaviorOverrides {
  readonly turnUpdates?: boolean;
  readonly outcomeFirst?: boolean;
  readonly autonomy?: boolean;
  readonly actDontRederive?: boolean;
  readonly deliveringWork?: boolean;
  readonly frontendGuidance?: boolean;
}

export function readPromptBehaviorOverrides(
  env: NodeJS.ProcessEnv = process.env,
): PromptBehaviorOverrides {
  return Object.freeze({
    turnUpdates: parseBoolean(env[`${BRAND_FIXED_ENV_PREFIX}TURN_UPDATES`]),
    outcomeFirst: parseBoolean(env[`${BRAND_FIXED_ENV_PREFIX}OUTCOME_FIRST`]),
    autonomy: parseBoolean(env[`${BRAND_FIXED_ENV_PREFIX}AUTONOMY`]),
    actDontRederive: parseBoolean(
      env[`${BRAND_FIXED_ENV_PREFIX}ACT_DONT_REDERIVE`],
    ),
    deliveringWork: parseBoolean(
      env[`${BRAND_FIXED_ENV_PREFIX}DELIVERING_WORK`],
    ),
    frontendGuidance: parseBoolean(
      env[`${BRAND_FIXED_ENV_PREFIX}FRONTEND_GUIDANCE`],
    ),
  });
}

function explicitMode(
  mode: RemoteSectionMode | undefined,
): boolean | undefined {
  return mode === undefined ? undefined : mode === 'enable';
}

/** Resolve model policy separately from prompt length and execution surface. */
export function resolvePromptBehavior(options: {
  readonly effectiveModel: string;
  readonly bundle: PromptBundle;
  readonly policy: PromptPolicySnapshot;
  readonly overrides?: PromptBehaviorOverrides;
}): {
  readonly communication: ResolvedCommunication;
  readonly autonomy: boolean;
  readonly actDontRederive: boolean;
  readonly deliveringWork: boolean;
} {
  const { effectiveModel, bundle, policy, overrides = {} } = options;
  const behaviorByModel = policy.behaviorByModel;
  const model =
    behaviorByModel && Object.hasOwn(behaviorByModel, effectiveModel)
      ? behaviorByModel[effectiveModel]
      : undefined;
  const flags = policy.behaviorFlags;
  const mitigations = model?.mitigations === true;
  const modernDefaults = model?.modernDefaults === true;
  const extendedDefaults =
    model?.extendedDefaults === true &&
    flags?.extendedDefaultsDisabled !== true;

  const turnUpdates =
    overrides.turnUpdates ??
    explicitMode(policy.sectionGates['communication.turn_updates']) ??
    model?.turnUpdates ??
    (modernDefaults || flags?.turnUpdates === true);
  const outcomeFirst =
    mitigations ||
    overrides.outcomeFirst === true ||
    model?.outcomeFirst === true ||
    flags?.outcomeFirst === true;
  const variant: CommunicationVariant = turnUpdates
    ? 'turn_updates'
    : outcomeFirst
      ? 'outcome_first'
      : bundle === 'lean'
        ? 'code_style'
        : 'standard';

  return Object.freeze({
    communication: Object.freeze({
      variant,
      finalMessageRequired:
        variant === 'outcome_first' && mitigations && flags?.brief !== true,
    }),
    autonomy:
      flags?.autonomyEnabled !== false &&
      (mitigations ||
        overrides.autonomy === true ||
        policy.sectionGates['behavior.autonomy'] === 'enable' ||
        flags?.autonomy === true),
    actDontRederive:
      overrides.actDontRederive ??
      policy.sectionGates['behavior.act_dont_rederive'] === 'enable',
    deliveringWork:
      overrides.deliveringWork ??
      explicitMode(policy.sectionGates['behavior.delivering_work']) ??
      (modernDefaults || extendedDefaults || flags?.deliveringWork === true),
  });
}
