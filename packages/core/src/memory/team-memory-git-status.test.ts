/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTeamMemoryShareabilityWarning } from './team-memory-git-status.js';
import { clearAutoMemoryRootCache, getTeamAutoMemoryRoot } from './paths.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(label: string): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `qwen-gitstatus-${label}-`),
  );
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', `${label}@example.com`);
  git(dir, 'config', 'user.name', label);
  return dir;
}

describe('getTeamMemoryShareabilityWarning', () => {
  const cleanup: string[] = [];

  beforeEach(() => clearAutoMemoryRootCache());

  afterEach(() => {
    clearAutoMemoryRootCache();
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the team dir is git-tracked', () => {
    const repo = initRepo('tracked');
    cleanup.push(repo);
    expect(getTeamMemoryShareabilityWarning(repo)).toBeNull();
  });

  it('warns when there is no git repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitstatus-nogit-'));
    cleanup.push(dir);
    const warning = getTeamMemoryShareabilityWarning(dir);
    expect(warning).toContain('not inside a git repository');
    expect(warning).toContain(getTeamAutoMemoryRoot(dir));
  });

  it('warns when a directory-form .gitignore swallows the team dir', () => {
    const repo = initRepo('ignored');
    cleanup.push(repo);
    // The common pitfall: ignoring `.qwen/` (directory form) makes git skip the
    // folder entirely, so memories are silently never tracked.
    fs.writeFileSync(path.join(repo, '.gitignore'), '.qwen/\n');
    const warning = getTeamMemoryShareabilityWarning(repo);
    expect(warning).toContain('git-ignored');
  });

  it('returns null when .qwen/* re-includes the team dir', () => {
    const repo = initRepo('reinclude');
    cleanup.push(repo);
    // The file-glob form CAN be escaped by a re-include below it.
    fs.writeFileSync(
      path.join(repo, '.gitignore'),
      '.qwen/*\n!.qwen/team-memory/\n!.qwen/team-memory/**\n',
    );
    expect(getTeamMemoryShareabilityWarning(repo)).toBeNull();
  });

  it('warns when topic files are ignored even though the index is re-included', () => {
    const repo = initRepo('topicignored');
    cleanup.push(repo);
    // Index re-included, but the actual memory files stay ignored — the shared
    // index would point at files no collaborator can see. Judging by the index
    // alone (pre-fix) would wrongly report this as shareable.
    fs.writeFileSync(
      path.join(repo, '.gitignore'),
      '.qwen/team-memory/*.md\n!.qwen/team-memory/MEMORY.md\n',
    );
    const warning = getTeamMemoryShareabilityWarning(repo);
    expect(warning).toContain('git-ignored');
  });
});
