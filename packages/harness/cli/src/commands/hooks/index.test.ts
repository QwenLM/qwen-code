/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/outputListeners.js', () => ({
  initializeOutputListenersAndFlush: vi.fn(),
}));

import { createHooksCommand } from './index.js';

describe('hooksCommand', () => {
  it('has the expected command signature', () => {
    const cmd = createHooksCommand();
    expect(cmd.name()).toBe('hooks');
    expect(cmd.aliases()).toContain('hook');
    expect(cmd.description()).toMatch(/hook/i);
  });

  it('registers migrate subcommand', () => {
    const cmd = createHooksCommand();
    const subcommandNames = cmd.commands.map((c) => c.name());
    expect(subcommandNames).toContain('migrate');
  });
});
