/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { collectActiveSkillEvolutionContext } from './skillEvolutionContext.js';

describe('collectActiveSkillEvolutionContext', () => {
  it('preserves ownership and every active skill when bundled skills share one location', () => {
    const context = collectActiveSkillEvolutionContext([
      {
        skill: {
          name: 'verify',
          location: '/app/bundled/SKILL.md',
          source: 'built-in',
        },
      },
      {
        skill: {
          name: 'debug',
          location: '/app/bundled/SKILL.md',
          source: 'built-in',
        },
      },
      {
        skill: {
          name: 'docx',
          location: '/home/test/.qwen/skills/docx/SKILL.md',
          source: 'user',
        },
      },
      {
        skill: {
          name: 'legacy-review',
          location: '/unknown/legacy-review/SKILL.md',
        },
      },
    ]);

    expect(context.skills).toEqual([
      { id: 'verify', source: 'built-in' },
      { id: 'debug', source: 'built-in' },
      { id: 'docx', source: 'user' },
      { id: 'legacy-review', source: undefined },
    ]);
    expect(new Set(context.roots.map(({ dir }) => dir))).toEqual(
      new Set([
        '/app/bundled',
        '/home/test/.qwen/skills/docx',
        '/unknown/legacy-review',
      ]),
    );
  });
});
