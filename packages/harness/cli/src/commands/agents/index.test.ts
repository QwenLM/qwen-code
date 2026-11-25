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

vi.mock('../../deferred.js', () => ({
  defer: (cmd: Record<string, unknown>) => cmd,
}));

import { createAgentsCommand } from './index.js';

describe('agentsCommand', () => {
  it('has the expected command signature', () => {
    const cmd = createAgentsCommand();
    expect(cmd.name()).toBe('agents');
    expect(cmd.aliases()).toContain('agent');
    expect(cmd.description()).toMatch(/agent/i);
  });

  it('registers setting-sources option', () => {
    const cmd = createAgentsCommand();
    const optionFlags = cmd.options.map((o) => o.long);
    expect(optionFlags).toContain('--setting-sources');
  });
});
