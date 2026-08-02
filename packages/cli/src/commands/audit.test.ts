/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditCommand } from './audit.js';

describe('auditCommand', () => {
  it('registers exactly the expected subcommands', () => {
    const source = readFileSync('src/commands/audit.ts', 'utf8');
    const subcommands = [...source.matchAll(/\.command\((\w+Command)\)/g)].map(
      (m) => m[1],
    );
    expect(subcommands).toEqual([
      'parseArgsCommand',
      'planFilesCommand',
      'agentPromptCommand',
    ]);
  });

  it('demandCommand text names each subcommand', () => {
    const source = readFileSync('src/commands/audit.ts', 'utf8');
    expect(source).toContain('plan-files');
    expect(source).toContain('agent-prompt');
  });

  it('is a CommandModule with an empty dispatch handler', () => {
    expect(auditCommand.command).toBe('audit');
    expect(typeof auditCommand.builder).toBe('function');
    expect(typeof auditCommand.handler).toBe('function');
  });
});
