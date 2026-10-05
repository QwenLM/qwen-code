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

  it('reports a legacy bare disable entry as the one blocking a prefixed skill', () => {
    // The disablement map is keyed by settings-entry name, so the row for a
    // skill registered as `acme:pdf` has to be found under either spelling.
    // A miss reads as "nothing blocks this", and the row offers a toggle
    // that appears to do nothing.
    const disablements = new Map([
      ['pdf', { reason: 'hard', lockedScope: 'user' } as const],
    ]);

    expect(
      mapSkillConfigToStatus(
        makeSkill({
          name: 'acme:pdf',
          authoredName: 'pdf',
          level: 'extension',
          extensionName: 'acme',
        }),
        disablements,
      ),
    ).toMatchObject({
      status: 'disabled',
      name: 'acme:pdf',
      disabledReason: 'hard',
      lockedScope: 'user',
    });
  });

  it('does not blame a prefixed disable entry on a different skill of the same authored name', () => {
    // `other:pdf` is a restriction on another extension's skill. Matching the
    // authored part alone would disable this row for a rule that is not about
    // it — and the same mistake in the reverse direction is a privilege
    // escalation, so the pair is checked both ways.
    const disablements = new Map([['other:pdf', { reason: 'hard' } as const]]);

    expect(
      mapSkillConfigToStatus(
        makeSkill({
          name: 'acme:pdf',
          authoredName: 'pdf',
          level: 'extension',
          extensionName: 'acme',
        }),
        disablements,
      ),
    ).not.toHaveProperty('disabledReason');
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

  it('surfaces optional model and extension identity only when present', () => {
    const nonExtension = mapSkillConfigToStatus(
      makeSkill({
        extensionName: 'ignored',
        extensionDisplayName: 'Ignored',
      }),
    );
    expect(nonExtension).not.toHaveProperty('model');
    expect(nonExtension).not.toHaveProperty('extensionName');
    expect(nonExtension).not.toHaveProperty('extensionDisplayName');

    const status = mapSkillConfigToStatus(
      makeSkill({
        level: 'extension',
        model: 'gpt-4o',
        extensionName: 'acme',
        extensionDisplayName: 'Acme Tools',
      }),
    );
    expect(status.model).toBe('gpt-4o');
    expect(status.extensionName).toBe('acme');
    expect(status.extensionDisplayName).toBe('Acme Tools');
  });
});
