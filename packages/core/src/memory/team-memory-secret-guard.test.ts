/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkTeamMemorySecrets,
  checkWorkspaceTeamMemorySecrets,
} from './team-memory-secret-guard.js';
import { getTeamAutoMemoryRoot } from './paths.js';

describe('checkTeamMemorySecrets', () => {
  let projectRoot: string;
  let teamFile: string;
  let outsideFile: string;
  const secret = `ghp_${'a'.repeat(36)}`;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-guard-'));
    fs.mkdirSync(path.join(projectRoot, '.git'));
    teamFile = path.join(getTeamAutoMemoryRoot(projectRoot), 'feedback/x.md');
    outsideFile = path.join(projectRoot, 'src/config.ts');
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('blocks a secret written to a team path', () => {
    const msg = checkTeamMemorySecrets(
      teamFile,
      `token=${secret}`,
      projectRoot,
    );
    expect(msg).toMatch(
      /team memory is shared with all repository collaborators/i,
    );
    expect(msg).toContain('GitHub PAT');
    expect(msg).not.toContain(secret);
  });

  it('allows clean content on a team path', () => {
    expect(
      checkTeamMemorySecrets(
        teamFile,
        'Use real DBs in integration tests.',
        projectRoot,
      ),
    ).toBeNull();
  });

  it('ignores secrets written outside the team directory', () => {
    expect(
      checkTeamMemorySecrets(outsideFile, `token=${secret}`, projectRoot),
    ).toBeNull();
  });

  it('classifies no-follow workspace paths without pathname I/O or a host git root', () => {
    const file = path.join(projectRoot, '.qwen/team-memory/note.md');
    const exists = vi.spyOn(fs, 'existsSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    syncBuiltinESMExports();
    try {
      expect(
        checkWorkspaceTeamMemorySecrets(file, secret, projectRoot),
      ).toMatch(/team memory is shared/i);
      expect(
        checkWorkspaceTeamMemorySecrets(file, 'safe note', projectRoot),
      ).toBeNull();
      for (const relative of [
        '.qwen/team-memory-other/note.md',
        '.qwen/team-memory/../outside.md',
        'src/note.md',
      ])
        expect(
          checkWorkspaceTeamMemorySecrets(
            path.join(projectRoot, relative),
            secret,
            projectRoot,
          ),
        ).toBeNull();
      expect(exists).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      exists.mockRestore();
      realpath.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('blocks secrets written through a symlink into team memory', () => {
    const root = getTeamAutoMemoryRoot(projectRoot);
    fs.mkdirSync(root, { recursive: true });
    const alias = path.join(projectRoot, 'alias');
    fs.symlinkSync(root, alias, 'dir');

    expect(
      checkTeamMemorySecrets(
        path.join(alias, 'leak.md'),
        `token=${secret}`,
        projectRoot,
      ),
    ).toMatch(/team memory is shared/i);
  });
});
