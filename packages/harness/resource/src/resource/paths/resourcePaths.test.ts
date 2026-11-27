/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  createProjectResourcePaths,
  createUserResourcePaths,
} from './resourcePaths.js';

describe('createUserResourcePaths', () => {
  it('resolves the user root and overrides without a workspace', () => {
    const homeDir = join(process.cwd(), '用户 home');
    const root = join(homeDir, '.custom');
    expect(
      createUserResourcePaths({ homeDir, configDirName: '.custom' }),
    ).toEqual({
      root,
      skillsDir: join(root, 'skills'),
      commandsDir: join(root, 'commands'),
      agentsDir: join(root, 'agents'),
      outputStylesDir: join(root, 'output-styles'),
    });
    const override = join(homeDir, '配置 override');
    expect(
      createUserResourcePaths({ homeDir, globalConfigDirOverride: override })
        .root,
    ).toBe(override);
  });
});

describe('createProjectResourcePaths', () => {
  it('derives only project paths', () => {
    const cwd = join(process.cwd(), '中文 project');
    const projectRoot = join(cwd, '.qwen');
    const paths = createProjectResourcePaths({ cwd });

    expect(paths).not.toHaveProperty('global');
    expect(paths.project.root).toBe(projectRoot);
    expect(paths.project).not.toHaveProperty('settingsJson');
    expect(paths.project).not.toHaveProperty('localSettingsJson');
    expect(paths.project.mcpJson).toBe(join(cwd, '.mcp.json'));
    const override = join(cwd, '配置 override');
    expect(
      createProjectResourcePaths({ cwd, projectConfigDirOverride: override })
        .project.root,
    ).toBe(override);
  });
});
