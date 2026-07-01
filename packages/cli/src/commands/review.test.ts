/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Argv, CommandModule } from 'yargs';
import { reviewCommand } from './review.js';

// Guards the `qwen review` subcommand surface. The `deterministic` subcommand
// was the internal backend for the /review skill's old Step 3; when that step
// was removed it became orphaned and was deleted. This test ensures it stays
// gone and the remaining internal helpers stay registered, so a future edit
// can't silently re-add `deterministic`, drop one of the others, or let the
// `describe` / demand text drift.
describe('reviewCommand', () => {
  function registeredSubcommands(): string[] {
    const names: string[] = [];
    const stub = {
      command: (m: CommandModule) => {
        names.push(String(m.command).split(' ')[0]);
        return stub;
      },
      demandCommand: () => stub,
      version: () => stub,
    } as unknown as Argv;
    (reviewCommand.builder as (y: Argv) => Argv)(stub);
    return names;
  }

  it('registers exactly the expected internal helper subcommands', () => {
    expect(registeredSubcommands()).toEqual([
      'fetch-pr',
      'pr-context',
      'load-rules',
      'presubmit',
      'cleanup',
    ]);
  });

  it('does not register the removed `deterministic` subcommand', () => {
    expect(registeredSubcommands()).not.toContain('deterministic');
  });

  it('describe no longer mentions deterministic analysis', () => {
    expect(reviewCommand.describe).not.toMatch(/deterministic/i);
  });
});
