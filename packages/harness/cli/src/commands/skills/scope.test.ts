/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SKILL_SCOPE_CHOICES,
  createSkillScopeOption,
  normalizeSkillScope,
} from './scope.js';

describe('skills scope option', () => {
  it('accepts user, workspace and the project alias', () => {
    expect(SKILL_SCOPE_CHOICES).toEqual(['user', 'workspace', 'project']);
  });

  it('maps project onto workspace', () => {
    expect(normalizeSkillScope('project')).toBe('workspace');
  });

  it('keeps workspace as workspace', () => {
    expect(normalizeSkillScope('workspace')).toBe('workspace');
  });

  it('falls back to user for user and for missing values', () => {
    expect(normalizeSkillScope('user')).toBe('user');
    expect(normalizeSkillScope(undefined)).toBe('user');
  });

  it('builds a -s / --scope option with the requested default', () => {
    const option = createSkillScopeOption('desc');
    expect(option.short).toBe('-s');
    expect(option.long).toBe('--scope');
    expect(option.defaultValue).toBe('user');

    const workspaceDefault = createSkillScopeOption('desc', 'workspace');
    expect(workspaceDefault.defaultValue).toBe('workspace');
  });
});
