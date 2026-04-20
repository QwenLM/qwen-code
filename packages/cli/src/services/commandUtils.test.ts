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
  // ── Priority 1: explicit supportedModes ───────────────────────────────
  it('explicit supportedModes overrides commandType inference', () => {
    const cmd = makeCmd({
      commandType: 'local',
      supportedModes: ['interactive'],
    });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('explicit supportedModes can expand to all modes even for local-jsx', () => {
    const cmd = makeCmd({
      commandType: 'local-jsx',
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

  // ── Priority 2: commandType inference ─────────────────────────────────
  it('commandType: prompt infers all modes', () => {
    const cmd = makeCmd({ kind: CommandKind.SKILL, commandType: 'prompt' });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('commandType: local infers interactive only (conservative default)', () => {
    const cmd = makeCmd({ commandType: 'local' });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: local-jsx infers interactive only', () => {
    const cmd = makeCmd({ commandType: 'local-jsx' });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: local with explicit supportedModes can unlock non_interactive', () => {
    const cmd = makeCmd({
      commandType: 'local',
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  // ── Priority 3: CommandKind fallback (backward compat) ────────────────
  it('no commandType, CommandKind.BUILT_IN falls back to interactive only', () => {
    const cmd = makeCmd({ kind: CommandKind.BUILT_IN });
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('no commandType, CommandKind.FILE falls back to all modes', () => {
    const cmd = makeCmd({ kind: CommandKind.FILE });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('no commandType, CommandKind.SKILL falls back to all modes', () => {
    const cmd = makeCmd({ kind: CommandKind.SKILL });
    expect(getEffectiveSupportedModes(cmd)).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('no commandType, CommandKind.MCP_PROMPT falls back to all modes (fixes original bug)', () => {
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
      commandType: 'local',
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    }),
    makeCmd({
      name: 'model',
      commandType: 'local-jsx',
      // no explicit supportedModes → interactive only
    }),
    makeCmd({
      name: 'review',
      kind: CommandKind.SKILL,
      commandType: 'prompt',
    }),
    makeCmd({
      name: 'gh-prompt',
      kind: CommandKind.MCP_PROMPT,
      commandType: 'prompt',
    }),
    makeCmd({
      name: 'my-script',
      kind: CommandKind.FILE,
      commandType: 'prompt',
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

  it('non_interactive mode excludes local-jsx commands', () => {
    const result = filterCommandsForMode(commands, 'non_interactive');
    expect(result.map((c) => c.name)).toEqual([
      'init',
      'review',
      'gh-prompt',
      'my-script',
    ]);
  });

  it('acp mode excludes local-jsx commands', () => {
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
      makeCmd({ name: 'hidden-cmd', commandType: 'local', hidden: true }),
    ];
    const result = filterCommandsForMode(withHidden, 'non_interactive');
    // filterCommandsForMode does NOT filter hidden — it only filters by mode
    // hidden-cmd has commandType: 'local' but no supportedModes, so it's interactive only
    expect(result.some((c) => c.name === 'hidden-cmd')).toBe(false);
  });

  it('hidden local command with explicit supportedModes still passes mode filter', () => {
    const withHidden = [
      ...commands,
      makeCmd({
        name: 'hidden-cmd',
        commandType: 'local',
        hidden: true,
        supportedModes: ['interactive', 'non_interactive', 'acp'],
      }),
    ];
    const result = filterCommandsForMode(withHidden, 'non_interactive');
    // filterCommandsForMode passes it through — CommandService.getCommandsForMode removes hidden
    expect(result.some((c) => c.name === 'hidden-cmd')).toBe(true);
  });

  it('returns empty array when no commands match', () => {
    const jsxOnly = [makeCmd({ name: 'model', commandType: 'local-jsx' })];
    expect(filterCommandsForMode(jsxOnly, 'non_interactive')).toEqual([]);
  });
});
