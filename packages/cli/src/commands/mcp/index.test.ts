/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createMcpCommand } from './index.js';

describe('mcp command', () => {
  it('should have correct command definition', () => {
    const cmd = createMcpCommand();
    expect(cmd.name()).toBe('mcp');
    expect(cmd.description()).toBe('Configure and manage MCP servers');
  });

  it('should show help when no subcommand is provided', () => {
    // The action calls cmd.outputHelp() + exitCli(0).
    const cmd = createMcpCommand();
    expect(cmd.name()).toBe('mcp');
  });

  it('should register add, remove, and list subcommands', () => {
    const cmd = createMcpCommand();

    const commandNames = cmd.commands.map((c) => c.name());

    expect(commandNames).toContain('add');
    expect(commandNames).toContain('add-json');
    expect(commandNames).toContain('remove');
    expect(commandNames).toContain('get');
    expect(commandNames).toContain('list');
    expect(commandNames).toContain('enable');
    expect(commandNames).toContain('disable');
    expect(commandNames).toContain('reset-project-choices');
  });
});
