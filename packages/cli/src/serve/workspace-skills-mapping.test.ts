/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { SkillConfig } from '@qwen-code/qwen-code-core';
import { mapSkillConfigToStatus } from './workspace-skills-mapping.js';

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'review',
    description: 'Review changed code',
    level: 'bundled',
    ...overrides,
  } as SkillConfig;
}

describe('mapSkillConfigToStatus', () => {
  it('maps an invocable skill to an ok status with its core fields', () => {
    const status = mapSkillConfigToStatus(
      makeSkill({ argumentHint: '[pr-number]' }),
    );

    expect(status).toEqual({
      kind: 'skill',
      status: 'ok',
      name: 'review',
      description: 'Review changed code',
      level: 'bundled',
      modelInvocable: true,
      argumentHint: '[pr-number]',
    });
  });

  it('keeps a disable-model-invocation skill available for manual use', () => {
    const status = mapSkillConfigToStatus(
      makeSkill({ name: 'internal', disableModelInvocation: true }),
    );

    expect(status.status).toBe('ok');
    expect(status.modelInvocable).toBe(false);
    expect(status.name).toBe('internal');
  });

  it('marks a settings-disabled skill as disabled', () => {
    const status = mapSkillConfigToStatus(
      makeSkill({ name: 'internal' }),
      new Set(['internal']),
    );

    expect(status.status).toBe('disabled');
    expect(status.modelInvocable).toBe(true);
    expect(status.name).toBe('internal');
  });

  it('marks a forced-disabled skill as disabled', () => {
    const status = mapSkillConfigToStatus(makeSkill(), new Set(), {
      disabled: true,
    });

    expect(status.status).toBe('disabled');
    expect(status.modelInvocable).toBe(true);
  });

  it('surfaces optional model and extensionName only when present', () => {
    expect(mapSkillConfigToStatus(makeSkill())).not.toHaveProperty('model');
    expect(mapSkillConfigToStatus(makeSkill())).not.toHaveProperty(
      'extensionName',
    );

    const status = mapSkillConfigToStatus(
      makeSkill({ model: 'gpt-4o', extensionName: 'acme' }),
    );
    expect(status.model).toBe('gpt-4o');
    expect(status.extensionName).toBe('acme');
  });
});
