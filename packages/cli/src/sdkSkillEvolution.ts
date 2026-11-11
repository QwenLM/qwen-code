/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SdkSkillEvolutionConfig = {
  requester: 'sdk';
  mode: 'native' | 'custom';
  generation?: {
    enabled?: boolean;
    prompt?: string;
    maxSuggestions?: number;
    turnComplete?: {
      enabled?: boolean;
      reviewThreshold?: number;
      shouldReviewCallbackId?: string;
      timeoutMs?: number;
      onGateError?: 'skip' | 'report_failed';
    };
  };
};

export type SdkEvolutionConfig = {
  skill?: SdkSkillEvolutionConfig;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function reviewThreshold(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 10
  ) {
    throw new Error(
      'evolution.skill.generation.turnComplete.reviewThreshold must be an integer between 1 and 10',
    );
  }
  return value;
}

export function parseSdkSkillEvolutionConfig(
  value: unknown,
): SdkSkillEvolutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value['requester'] !== 'sdk') {
    throw new Error('evolution.skill.requester must be "sdk"');
  }
  if (value['mode'] !== 'native' && value['mode'] !== 'custom') {
    throw new Error('evolution.skill.mode must be "native" or "custom"');
  }
  if (value['mode'] === 'native') {
    const rawGeneration = value['generation'];
    if (rawGeneration === undefined) {
      return { requester: 'sdk', mode: 'native' };
    }
    if (!isRecord(rawGeneration)) {
      throw new Error('evolution.skill.generation must be an object');
    }
    if (Object.keys(rawGeneration).some((key) => key !== 'turnComplete')) {
      throw new Error(
        'evolution.skill mode "native" only accepts generation.turnComplete.reviewThreshold',
      );
    }
    const rawTurn = rawGeneration['turnComplete'];
    if (!isRecord(rawTurn)) {
      throw new Error(
        'evolution.skill.generation.turnComplete must be an object',
      );
    }
    if (Object.keys(rawTurn).some((key) => key !== 'reviewThreshold')) {
      throw new Error(
        'evolution.skill mode "native" only accepts generation.turnComplete.reviewThreshold',
      );
    }
    return {
      requester: 'sdk',
      mode: 'native',
      generation: {
        turnComplete: {
          reviewThreshold: reviewThreshold(rawTurn['reviewThreshold']),
        },
      },
    };
  }

  const rawGeneration = value['generation'];
  if (rawGeneration !== undefined && !isRecord(rawGeneration)) {
    throw new Error('evolution.skill.generation must be an object');
  }
  if (rawGeneration === undefined) {
    return { requester: 'sdk', mode: 'custom', generation: undefined };
  }
  if (rawGeneration['roots'] !== undefined) {
    throw new Error(
      'evolution.skill.generation does not accept roots; roots are derived from loaded skills',
    );
  }

  const enabled = rawGeneration['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error('evolution.skill.generation.enabled must be boolean');
  }
  const rawPrompt = rawGeneration['prompt'];
  const prompt =
    rawPrompt === undefined
      ? undefined
      : nonEmptyString(rawPrompt, 'evolution.skill.generation.prompt');
  const maxSuggestions = rawGeneration['maxSuggestions'];
  if (
    maxSuggestions !== undefined &&
    (typeof maxSuggestions !== 'number' ||
      !Number.isInteger(maxSuggestions) ||
      maxSuggestions < 1 ||
      maxSuggestions > 10)
  ) {
    throw new Error(
      'evolution.skill.generation.maxSuggestions must be between 1 and 10',
    );
  }

  let turnComplete:
    | NonNullable<SdkSkillEvolutionConfig['generation']>['turnComplete']
    | undefined;
  const rawTurn = rawGeneration['turnComplete'];
  if (rawTurn !== undefined) {
    if (!isRecord(rawTurn)) {
      throw new Error(
        'evolution.skill.generation.turnComplete must be an object',
      );
    }
    const turnEnabled = rawTurn['enabled'];
    if (turnEnabled !== undefined && typeof turnEnabled !== 'boolean') {
      throw new Error(
        'evolution.skill.generation.turnComplete.enabled must be boolean',
      );
    }
    const parsedReviewThreshold = reviewThreshold(rawTurn['reviewThreshold']);
    const rawCallbackId = rawTurn['shouldReviewCallbackId'];
    const shouldReviewCallbackId =
      rawCallbackId === undefined
        ? undefined
        : nonEmptyString(
            rawCallbackId,
            'evolution.skill.generation.turnComplete.shouldReviewCallbackId',
          );
    const timeoutMs = rawTurn['timeoutMs'];
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0)
    ) {
      throw new Error(
        'evolution.skill.generation.turnComplete.timeoutMs must be a positive finite number',
      );
    }
    const onGateError = rawTurn['onGateError'];
    if (
      onGateError !== undefined &&
      onGateError !== 'skip' &&
      onGateError !== 'report_failed'
    ) {
      throw new Error(
        'evolution.skill.generation.turnComplete.onGateError must be "skip" or "report_failed"',
      );
    }
    turnComplete = {
      enabled: turnEnabled ?? true,
      reviewThreshold: parsedReviewThreshold,
      shouldReviewCallbackId,
      timeoutMs,
      onGateError,
    };
  }
  if (enabled === false && turnComplete?.enabled === true) {
    throw new Error(
      'evolution.skill.generation.turnComplete cannot be enabled when generation.enabled is false',
    );
  }
  return {
    requester: 'sdk',
    mode: 'custom',
    generation: {
      enabled: enabled ?? true,
      prompt,
      maxSuggestions,
      turnComplete,
    },
  };
}

export function parseSdkEvolutionConfig(
  value: unknown,
): SdkEvolutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('evolution must be an object');
  return {
    skill: parseSdkSkillEvolutionConfig(value['skill']),
  };
}

export function resolveSdkSkillEvolutionEnablement(
  config: SdkSkillEvolutionConfig,
): { generationEnabled: boolean; turnCompleteEnabled: boolean } {
  const generationEnabled = config.generation?.enabled !== false;
  return {
    generationEnabled,
    turnCompleteEnabled:
      generationEnabled && config.generation?.turnComplete?.enabled !== false,
  };
}
