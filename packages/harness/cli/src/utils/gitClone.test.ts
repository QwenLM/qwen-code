/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneFromGit } from './gitClone.js';

// Exercise real Git: mocks cannot catch dependency-level argument rejection.
describe('cloneFromGit with real Git', () => {
  let root: string;
  let source: string;
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'skill-git-'));
    source = path.join(root, 'source');
    mkdirSync(source);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global'));
    vi.stubEnv('GITHUB_TOKEN', '');
    git(source, ['init']);
    git(source, ['config', 'user.email', 'test@example.invalid']);
    git(source, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(source, 'content'), 'default');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'initial']);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('clones, fetches and checks out the requested ref without running hooks or fsmonitor', async () => {
    const marker = path.join(root, 'executed');
    const hooks = path.join(root, 'hooks');
    mkdirSync(hooks);
    const payload = `#!/bin/sh\ntouch '${marker}'\n`;
    writeFileSync(path.join(hooks, 'post-checkout'), payload, { mode: 0o755 });
    const monitor = path.join(root, 'monitor');
    writeFileSync(monitor, payload, { mode: 0o755 });
    git(source, ['checkout', '-b', 'selected']);
    writeFileSync(path.join(source, 'content'), 'selected');
    git(source, ['commit', '-am', 'selected']);
    git(source, ['checkout', '-b', 'default', 'HEAD~1']);
    git(source, ['config', '--global', 'core.hooksPath', hooks]);
    git(source, ['config', '--global', 'core.fsmonitor', monitor]);
    const destination = path.join(root, 'destination');
    mkdirSync(destination);
    await cloneFromGit({ source, ref: 'selected', type: 'git' }, destination);
    expect(readFileSync(path.join(destination, 'content'), 'utf8')).toBe(
      'selected',
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects ext transport even when ambient config allows it', async () => {
    git(source, ['config', '--global', 'protocol.ext.allow', 'always']);
    const destination = path.join(root, 'destination');
    mkdirSync(destination);
    await expect(
      cloneFromGit({ source: 'ext::echo test', type: 'git' }, destination),
    ).rejects.toThrow("transport 'ext' not allowed");
  });
});
