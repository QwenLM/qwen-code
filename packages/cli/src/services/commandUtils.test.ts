/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getEffectiveSupportedModes,
  filterCommandsForMode,
} from './commandUtils.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

/** Minimal SlashCommand factory for tests */
function makeCmd(overrides: Partial<SlashCommand>): SlashCommand {
  return {
    name: 'test',
    description: 'test command',
    kind: CommandKind.BUILT_IN,
    ...overrides,
  };
}

describe('getEffectiveSupportedModes', () => {
  // ── Explicit supportedModes ────────────────────────────────────────────
  it('uses explicit supportedModes when declared', () => {
    const cmd = makeCmd({ supportedModes: ['interactive'] });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('supportedModes can declare all modes', () => {
    const cmd = makeCmd({
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('explicit empty supportedModes returns empty array', () => {
    const cmd = makeCmd({ supportedModes: [] });
    expect(getEffectiveSupportedModes(cmd)).toEqual([]);
  });

  // ── CommandKind fallback (no supportedModes) ───────────────────────────
  it('CommandKind.BUILT_IN without supportedModes falls back to interactive only', () => {
    const cmd = makeCmd({ kind: CommandKind.BUILT_IN });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('CommandKind.FILE without supportedModes falls back to all modes', () => {
    const cmd = makeCmd({ kind: CommandKind.FILE });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('CommandKind.SKILL without supportedModes falls back to all modes', () => {
    const cmd = makeCmd({ kind: CommandKind.SKILL });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('CommandKind.MCP_PROMPT without supportedModes falls back to all modes (fixes original bug)', () => {
    const cmd = makeCmd({ kind: CommandKind.MCP_PROMPT });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });
});

describe('filterCommandsForMode', () => {
  const commands: SlashCommand[] = [
    makeCmd({
      name: 'init',
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    }),
    makeCmd({
      name: 'model',
      supportedModes: ['interactive'],
    }),
    makeCmd({
      name: 'review',
      kind: CommandKind.SKILL,
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    }),
    makeCmd({
      name: 'gh-prompt',
      kind: CommandKind.MCP_PROMPT,
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    }),
    makeCmd({
      name: 'my-script',
      kind: CommandKind.FILE,
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    }),
  ];

  it('interactive mode includes all commands', () => {
    const result = filterCommandsForMode(commands, 'interactive');
    expect(result.map((c) => c.name)).toEqual([
      'init',
      'model',
      'review',
      'gh-prompt',
      'my-script',
    ]);
  });

  it('non_interactive mode excludes interactive-only commands', () => {
    const result = filterCommandsForMode(commands, 'non_interactive');
    expect(result.map((c) => c.name)).toEqual([
      'init',
      'review',
      'gh-prompt',
      'my-script',
    ]);
  });

  it('acp mode excludes interactive-only commands', () => {
    const result = filterCommandsForMode(commands, 'acp');
    expect(result.map((c) => c.name)).toEqual([
      'init',
      'review',
      'gh-prompt',
      'my-script',
    ]);
  });

  it('non_interactive includes MCP_PROMPT commands (bug fix)', () => {
    const result = filterCommandsForMode(commands, 'non_interactive');
    expect(result.some((c) => c.name === 'gh-prompt')).toBe(true);
  });

  it('does not filter hidden commands (hidden filtering is caller responsibility)', () => {
    const withHidden = [
      ...commands,
      makeCmd({
        name: 'hidden-cmd',
        hidden: true,
        // no supportedModes → BUILT_IN fallback → interactive only
      }),
    ];
    const result = filterCommandsForMode(withHidden, 'non_interactive');
    // filterCommandsForMode does NOT filter hidden — it only filters by mode
    expect(result.some((c) => c.name === 'hidden-cmd')).toBe(false);
  });

  it('hidden command with explicit all-mode supportedModes still passes mode filter', () => {
    const withHidden = [
      ...commands,
      makeCmd({
        name: 'hidden-cmd',
        hidden: true,
        supportedModes: ['interactive', 'non_interactive', 'acp'],
      }),
    ];
    const result = filterCommandsForMode(withHidden, 'non_interactive');
    // filterCommandsForMode passes it through — CommandService.getCommandsForMode removes hidden
    expect(result.some((c) => c.name === 'hidden-cmd')).toBe(true);
  });

  it('returns empty array when no commands match', () => {
    const jsxOnly = [
      makeCmd({ name: 'model', supportedModes: ['interactive'] }),
    ];
    expect(filterCommandsForMode(jsxOnly, 'non_interactive')).toEqual([]);
  });
});
