/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

import { SkillManager } from '@qwen-code/qwen-code-core';
import { createWorkspaceSkillsStatusProvider } from './workspace-skills-status.js';

describe('createWorkspaceSkillsStatusProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockWriteStderrLine.mockClear();
  });

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

  it('returns a non-initialized error status (and logs) when enumeration fails', async () => {
    vi.spyOn(SkillManager.prototype, 'listSkills').mockRejectedValueOnce(
      new Error('boom'),
    );
    const provider = createWorkspaceSkillsStatusProvider();

    const status = await provider('/ws');

    expect(status.initialized).toBe(false);
    expect(status.skills).toEqual([]);
    expect(status.workspaceCwd).toBe('/ws');
    expect(status.errors).toEqual([
      { kind: 'skills', status: 'error', error: 'boom' },
    ]);
    // Non-fatal failures are logged to the daemon's stderr.
    expect(mockWriteStderrLine).toHaveBeenCalledTimes(1);
    expect(mockWriteStderrLine.mock.calls[0][0]).toContain('boom');
  });

  it('reuses one SkillManager per workspace across calls', async () => {
    const listSpy = vi.spyOn(SkillManager.prototype, 'listSkills');
    const provider = createWorkspaceSkillsStatusProvider();

    await provider('/ws');
    await provider('/ws');

    // Memoized: the second query reuses the first SkillManager instance, so
    // listSkills is invoked on the same object rather than a freshly-scanned one.
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(listSpy.mock.instances[0]).toBe(listSpy.mock.instances[1]);
  });
});
