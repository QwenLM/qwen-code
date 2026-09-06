/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTeamMemorySecrets } from './team-memory-secret-guard.js';
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
