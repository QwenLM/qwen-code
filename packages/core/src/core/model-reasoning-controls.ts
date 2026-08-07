/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  clampReasoningEffort,
  normalizeReasoningEffort,
  type ReasoningEffort,
} from './reasoning-effort.js';

export interface ModelReasoningControlRegistration {
  readonly thinking?: {
    readonly defaultEnabled: boolean;
  };
  readonly effort?: {
    readonly supported: readonly ReasoningEffort[];
    readonly default: ReasoningEffort;
  };
}

export interface ModelReasoningPreference {
  thinkingEnabled?: boolean;
  effort?: ReasoningEffort;
}

export interface ResolvedModelReasoningControls {
  thinkingEnabled?: boolean;
  effort?: ReasoningEffort;
}

function defineModelReasoningControls(
  registrations: Record<string, ModelReasoningControlRegistration>,
): Readonly<Record<string, ModelReasoningControlRegistration>> {
  for (const [model, registration] of Object.entries(registrations)) {
    if (!registration.thinking && !registration.effort) {
      throw new Error(`${model} must register at least one reasoning control`);
    }
    if (
      registration.effort &&
      (registration.effort.supported.length === 0 ||
        !registration.effort.supported.includes(registration.effort.default))
    ) {
      throw new Error(
        `${model} reasoning effort default must be included in supported tiers`,
      );
    }
  }
  return registrations;
}

const MODEL_REASONING_CONTROLS = defineModelReasoningControls({
  'qwen3.8-max': {
    thinking: { defaultEnabled: true },
    effort: {
      supported: ['low', 'medium', 'xhigh'],
      default: 'xhigh',
    },
  },
} as const satisfies Record<string, ModelReasoningControlRegistration>);

export function getModelReasoningControls(
  baseModelId: string | undefined,
): ModelReasoningControlRegistration | undefined {
  // Own-property check: model ids are opaque user-configured strings, and a
  // bare bracket lookup would return inherited Object.prototype members
  // ('constructor', 'toString', ...) for unregistered ids colliding with them.
  if (!baseModelId || !Object.hasOwn(MODEL_REASONING_CONTROLS, baseModelId)) {
    return undefined;
  }
  return MODEL_REASONING_CONTROLS[baseModelId];
}

export function normalizeModelReasoningEffort(
  registration: ModelReasoningControlRegistration,
  effort: unknown,
): ReasoningEffort | undefined {
  if (!registration.effort) return undefined;
  const normalized =
    typeof effort === 'string' ? normalizeReasoningEffort(effort) : undefined;
  return normalized
    ? clampReasoningEffort(normalized, registration.effort.supported)
    : registration.effort.default;
}

export function resolveModelReasoningControls(
  baseModelId: string | undefined,
  preference: unknown,
): ResolvedModelReasoningControls | undefined {
  const registration = getModelReasoningControls(baseModelId);
  if (!registration) return undefined;
  return resolveModelReasoningControlRegistration(registration, preference);
}

export function resolveModelReasoningControlRegistration(
  registration: ModelReasoningControlRegistration,
  preference: unknown,
): ResolvedModelReasoningControls {
  const record =
    preference && typeof preference === 'object' && !Array.isArray(preference)
      ? (preference as Record<string, unknown>)
      : undefined;
  return {
    ...(registration.thinking
      ? {
          thinkingEnabled:
            typeof record?.['thinkingEnabled'] === 'boolean'
              ? record['thinkingEnabled']
              : registration.thinking.defaultEnabled,
        }
      : {}),
    ...(registration.effort
      ? {
          effort: normalizeModelReasoningEffort(
            registration,
            record?.['effort'],
          ),
        }
      : {}),
  };
}
