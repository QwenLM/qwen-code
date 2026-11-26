/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'node:path';
import { resolveConfigHome } from './configHome.js';

const DEFAULT_CONFIG_DIR_NAME = '.qwen';

export interface UserResourcePathOptions {
  homeDir?: string;
  configDirName?: string;
  globalConfigDirOverride?: string;
}

export interface ProjectResourcePathOptions {
  cwd: string;
  configDirName?: string;
  projectConfigDirOverride?: string;
}

export interface UserResourcePaths {
  root: string;
  skillsDir: string;
  commandsDir: string;
  agentsDir: string;
  outputStylesDir: string;
}

export interface ProjectResourcePaths {
  cwd: string;
  configDirName: string;
  project: {
    root: string;
    mcpJson: string;
    skillsDir: string;
    commandsDir: string;
    agentsDir: string;
    outputStylesDir: string;
  };
}

export function createUserResourcePaths(
  options: UserResourcePathOptions,
): UserResourcePaths {
  const configDirName = options.configDirName ?? DEFAULT_CONFIG_DIR_NAME;
  const globalRoot = options.globalConfigDirOverride
    ? resolve(options.globalConfigDirOverride)
    : resolveConfigHome({
        homeDir: options.homeDir,
        configDirName,
      });
  return {
    root: globalRoot,
    skillsDir: join(globalRoot, 'skills'),
    commandsDir: join(globalRoot, 'commands'),
    agentsDir: join(globalRoot, 'agents'),
    outputStylesDir: join(globalRoot, 'output-styles'),
  };
}

export function createProjectResourcePaths(
  options: ProjectResourcePathOptions,
): ProjectResourcePaths {
  const cwd = resolve(options.cwd);
  const configDirName = options.configDirName ?? DEFAULT_CONFIG_DIR_NAME;
  const projectRoot = options.projectConfigDirOverride
    ? resolve(options.projectConfigDirOverride)
    : join(cwd, configDirName);

  return {
    cwd,
    configDirName,
    project: {
      root: projectRoot,
      mcpJson: join(cwd, '.mcp.json'),
      skillsDir: join(projectRoot, 'skills'),
      commandsDir: join(projectRoot, 'commands'),
      agentsDir: join(projectRoot, 'agents'),
      outputStylesDir: join(projectRoot, 'output-styles'),
    },
  };
}
