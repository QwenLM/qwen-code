/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end coverage for issue #8575 with the REAL probe and classifier
 * (no fs mocking): ShellToolInvocation.getDefaultPermission must ask for
 * whitelisted read-only git commands when the repo-local `.git/config`
 * contains program-executing keys, and keep allowing them in clean repos.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellTool } from './shell.js';
import type { Config } from '../config/config.js';

describe('ShellTool git config probe end-to-end (#8575)', () => {
  let root: string;
  let cleanRepo: string;
  let dirtyRepo: string;

  function makeShellTool(targetDir: string): ShellTool {
    const config = {
      getTargetDir: () => targetDir,
      storage: { getUserSkillsDirs: () => [] },
      getWorkspaceContext: () => ({ isPathWithinWorkspace: () => true }),
    } as unknown as Config;
    return new ShellTool(config);
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-git-config-integ-'));

    cleanRepo = path.join(root, 'clean');
    fs.mkdirSync(path.join(cleanRepo, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(cleanRepo, '.git', 'config'),
      '[core]\n\tbare = false\n',
    );

    dirtyRepo = path.join(root, 'dirty');
    fs.mkdirSync(path.join(dirtyRepo, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(dirtyRepo, '.git', 'config'),
      '[diff]\n\texternal = /tmp/evil\n[core]\n\tfsmonitor = /tmp/evil\n',
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['git status', 'git diff', 'git log -p'])(
    'asks for %s when repo config executes programs',
    async (command) => {
      const invocation = makeShellTool(dirtyRepo).build({
        command,
        is_background: false,
      });
      expect(await invocation.getDefaultPermission()).toBe('ask');
    },
  );

  it.each(['git status', 'git diff', 'git log -p'])(
    'allows %s when repo config is clean',
    async (command) => {
      const invocation = makeShellTool(cleanRepo).build({
        command,
        is_background: false,
      });
      expect(await invocation.getDefaultPermission()).toBe('allow');
    },
  );

  it('allows non-git commands even in a dirty repo', async () => {
    const invocation = makeShellTool(dirtyRepo).build({
      command: 'ls -la',
      is_background: false,
    });
    expect(await invocation.getDefaultPermission()).toBe('allow');
  });

  it('honors the directory parameter over the target dir', async () => {
    const invocation = makeShellTool(cleanRepo).build({
      command: 'git status',
      directory: dirtyRepo,
      is_background: false,
    });
    expect(await invocation.getDefaultPermission()).toBe('ask');
  });
});
