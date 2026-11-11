/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  getScopedAutoMemoryDirs,
  getUserAutoMemoryDir,
  validateAutoMemoryWriteScope,
} from './structured-memory-store.js';

function createConfig(scopes: { user: boolean; project: boolean }): Config {
  return {
    storage: {
      getProjectMemoryTempDir: () => '/tmp/project-memory',
    },
    isAutoMemoryUserScopeEnabled: () => scopes.user,
    isAutoMemoryProjectScopeEnabled: () => scopes.project,
  } as unknown as Config;
}

describe('independent auto-memory scopes', () => {
  it.each([
    [{ user: true, project: true }, ['user', 'project']],
    [{ user: true, project: false }, ['user']],
    [{ user: false, project: true }, ['project']],
    [{ user: false, project: false }, []],
  ] as const)('selects enabled roots for %o', (scopes, expected) => {
    expect(getScopedAutoMemoryDirs(createConfig(scopes)).map(({ scope }) => scope))
      .toEqual(expected);
  });

  it('rejects writes to a disabled PROJECT root in USER-only mode', () => {
    expect(
      validateAutoMemoryWriteScope(
        '/tmp/project-memory/MEMORY.md',
        '- [Item](item.md) — item',
        createConfig({ user: true, project: false }),
      ),
    ).toBe('The project-scope auto-memory directory is disabled.');
  });

  it('rejects writes to a disabled USER root in PROJECT-only mode', () => {
    expect(
      validateAutoMemoryWriteScope(
        `${getUserAutoMemoryDir()}/MEMORY.md`,
        '- [Item](item.md) — item',
        createConfig({ user: false, project: true }),
      ),
    ).toBe('The user-scope auto-memory directory is disabled.');
  });

  it('rejects PROJECT-pinned content in the active USER root', () => {
    expect(
      validateAutoMemoryWriteScope(
        `${getUserAutoMemoryDir()}/project-context.md`,
        '---\nmetadata:\n  type: project\n---\nProject context',
        createConfig({ user: true, project: false }),
      ),
    ).toContain('The project-scope directory is not active.');
  });

  it('rejects USER-pinned content in the active PROJECT root', () => {
    expect(
      validateAutoMemoryWriteScope(
        '/tmp/project-memory/user-preference.md',
        '---\nmetadata:\n  type: user\n---\nUser preference',
        createConfig({ user: false, project: true }),
      ),
    ).toContain('The user-scope directory is not active.');
  });
});
