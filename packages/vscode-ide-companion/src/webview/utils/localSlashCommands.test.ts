/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import {
  isLocalFreshSessionCommand,
  mergeLocalAvailableCommands,
} from './localSlashCommands.js';

describe('mergeLocalAvailableCommands', () => {
  it('recognizes /clear as a local fresh-session command', () => {
    expect(isLocalFreshSessionCommand('/clear')).toBe(true);
    expect(isLocalFreshSessionCommand(' /clear ')).toBe(true);
    expect(isLocalFreshSessionCommand('/reset')).toBe(true);
    expect(isLocalFreshSessionCommand('/new')).toBe(true);
    expect(isLocalFreshSessionCommand('/help')).toBe(false);
    expect(isLocalFreshSessionCommand('clear')).toBe(false);
    expect(isLocalFreshSessionCommand(' reset ')).toBe(false);
  });

  it('injects a local clear command for the VS Code companion', () => {
    const commands = mergeLocalAvailableCommands([]);

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'clear',
          description: expect.stringContaining('fresh'),
        }),
      ]),
    );
    expect(commands[0]?.description).toContain('/reset');
    expect(commands[0]?.description).toContain('/new');
  });

  it('does not duplicate clear when ACP already exposes it', () => {
    const commands = mergeLocalAvailableCommands([
      {
        name: 'clear',
        description: 'Server clear command',
      } as AvailableCommand,
    ]);

    expect(commands.filter((command) => command.name === 'clear')).toHaveLength(
      1,
    );
  });
});
