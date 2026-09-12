/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';
import { createMemoryScopedAgentConfig } from './memory-scoped-agent-config.js';

describe('memory-scoped shell safety', () => {
  const tempDirs: string[] = [];

  const createRepo = (): string => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'qwen-memory-shell-'));
    tempDirs.push(cwd);
    execFileSync('git', ['init', '-q'], { cwd });
    return cwd;
  };

  const permissionManager = (config: Config): PermissionManager => {
    const pm = config.getPermissionManager?.();
    if (!pm) throw new Error('missing permission manager');
    return pm;
  };

  afterEach(() => {
    for (const cwd of tempDirs.splice(0)) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects raw env assignments before shell wrapper stripping', async () => {
    const projectRoot = createRepo();
    const pm = permissionManager(
      createMemoryScopedAgentConfig({} as Config, projectRoot, {
        allowShell: true,
      }),
    );

    await expect(
      pm.evaluate({
        toolName: ToolNames.SHELL,
        cwd: projectRoot,
        command: "bash -c 'git status'",
      }),
    ).resolves.toBe('allow');

    await expect(
      pm.evaluate({
        toolName: ToolNames.SHELL,
        cwd: projectRoot,
        command:
          "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=/tmp/evil bash -c 'git diff'",
      }),
    ).resolves.toBe('deny');

    await expect(
      pm.evaluate({
        toolName: ToolNames.SHELL,
        cwd: projectRoot,
        command: "FOO=$(printf x) bash -c 'git status'",
      }),
    ).resolves.toBe('deny');
  });
});
