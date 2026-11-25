/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import {
  isCommandAvailableInAcp,
  toAcpSupportedCommand,
} from './commandAvailability.js';

function command(overrides: Partial<SlashCommand>): SlashCommand {
  return {
    name: 'test',
    description: 'test command',
    kind: CommandKind.BUILT_IN,
    ...overrides,
  };
}

describe('ACP command availability', () => {
  it('keeps only ACP-safe built-in commands', () => {
    expect(
      isCommandAvailableInAcp(command({ name: 'rewind' })),
    ).toBe(true);
    expect(
      isCommandAvailableInAcp(command({ name: 'rename' })),
    ).toBe(true);
    expect(
      isCommandAvailableInAcp(command({ name: 'goal' })),
    ).toBe(true);

    for (const name of ['help', 'memory', 'review', 'plan', 'status']) {
      expect(isCommandAvailableInAcp(command({ name }))).toBe(false);
    }
  });

  it('keeps prompt-like dynamic command kinds', () => {
    expect(
      isCommandAvailableInAcp(
        command({ name: 'debug', kind: CommandKind.SKILL }),
      ),
    ).toBe(true);
    expect(
      isCommandAvailableInAcp(
        command({ name: 'todo', kind: CommandKind.PLUGIN }),
      ),
    ).toBe(true);
    expect(
      isCommandAvailableInAcp(
        command({ name: 'server-prompt', kind: CommandKind.MCP_PROMPT }),
      ),
    ).toBe(true);
    expect(
      isCommandAvailableInAcp(
        command({ name: 'dynamic-review', kind: CommandKind.DYNAMIC }),
      ),
    ).toBe(true);
  });

  it('excludes hidden commands, agent commands, and background loop commands', () => {
    expect(
      isCommandAvailableInAcp(command({ name: 'rewind', hidden: true })),
    ).toBe(false);
    expect(
      isCommandAvailableInAcp(
        command({ name: 'worker', kind: CommandKind.AGENT }),
      ),
    ).toBe(false);
    expect(
      isCommandAvailableInAcp(
        command({ name: 'loop', kind: CommandKind.SKILL }),
      ),
    ).toBe(false);
  });

  it('normalizes ACP argument hints for retained commands', () => {
    expect(toAcpSupportedCommand(command({ name: 'rewind' }))).toMatchObject({
      name: 'rewind',
      description:
        'Rewind conversation and checkpointed files to before a user message by id',
      argumentHint: '<message-id>',
    });
    expect(toAcpSupportedCommand(command({ name: 'rename' }))).toMatchObject({
      name: 'rename',
      argumentHint: '<title>',
    });
    expect(
      toAcpSupportedCommand(
        command({
          name: 'wiki-read',
          kind: CommandKind.SKILL,
          argNames: ['topic'],
        }),
      ),
    ).toMatchObject({
      name: 'wiki-read',
      argumentHint: ['topic'],
    });
  });
});
