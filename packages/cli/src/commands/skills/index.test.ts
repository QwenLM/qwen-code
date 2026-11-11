/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { createSkillsCommand } from './index.js';

vi.mock('../../utils/outputListeners.js', () => ({
  initializeOutputListenersAndFlush: vi.fn(),
}));

describe('skillsCommand', () => {
  it('should have correct command and aliases', () => {
    const cmd = createSkillsCommand();
    expect(cmd.name()).toBe('skills');
    expect(cmd.aliases()).toContain('skill');
    expect(cmd.description()).toBe('Manage agent skills.');
  });

  it('should register all subcommands', () => {
    const cmd = createSkillsCommand();
    const commandNames = cmd.commands.map((c) => c.name());

    expect(commandNames).toContain('list');
    expect(commandNames).toContain('enable');
    expect(commandNames).toContain('disable');
    expect(commandNames).toContain('install');
    expect(commandNames).toContain('link');
    expect(commandNames).toContain('uninstall');
  });
});
