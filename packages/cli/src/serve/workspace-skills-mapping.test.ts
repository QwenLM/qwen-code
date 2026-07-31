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
    filePath: '/skills/review/SKILL.md',
    body: 'Review instructions',
    ...overrides,
  };
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
      installedPath: '/skills/review/SKILL.md',
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

  it('only emits userInvocable when manual invocation is disabled', () => {
    expect(mapSkillConfigToStatus(makeSkill())).not.toHaveProperty(
      'userInvocable',
    );
    expect(
      mapSkillConfigToStatus(makeSkill({ userInvocable: false })),
    ).toMatchObject({ userInvocable: false });
  });

  it('marks a settings-disabled skill as disabled', () => {
    const status = mapSkillConfigToStatus(
      makeSkill({ name: 'internal' }),
      new Map([['internal', { reason: 'hard', lockedScope: 'user' }]]),
    );

    expect(status.status).toBe('disabled');
    expect(status.modelInvocable).toBe(true);
    expect(status.name).toBe('internal');
    expect(status.disabledReason).toBe('hard');
    expect(status.lockedScope).toBe('user');
  });

  it('marks a forced-disabled skill as disabled', () => {
    const status = mapSkillConfigToStatus(
      makeSkill(),
      new Map([['review', { reason: 'hard', lockedScope: 'user' }]]),
      { disabled: true },
    );

    expect(status.status).toBe('disabled');
    expect(status.modelInvocable).toBe(true);
    expect(status.disabledReason).toBe('inactive_extension');
    expect(status).not.toHaveProperty('lockedScope');
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
