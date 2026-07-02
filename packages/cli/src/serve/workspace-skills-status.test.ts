/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';

describe('createWorkspaceSkillsStatusProvider', () => {
  it('enumerates bundled skills (including /review) without an ACP child', async () => {
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider(process.cwd());

    expect(status.initialized).toBe(true);
    const review = status.skills.find((skill) => skill.name === 'review');
    expect(review).toBeDefined();
    expect(review?.kind).toBe('skill');
    expect(review?.level).toBe('bundled');
    // Skill-tool listing exposes the model-invocable flag; bundled /review is
    // invocable, and the argument hint drives the slash-command autocomplete.
    expect(review?.modelInvocable).toBe(true);
    expect(review?.argumentHint).toBeTruthy();
  });

  it('reports the queried workspace path', async () => {
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider('/some/workspace');

    expect(status.workspaceCwd).toBe('/some/workspace');
  });
});
