/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type EffortValue = EffortLevel | number;

export type FrontmatterShell = 'bash' | 'powershell';
export type SkillSource = 'built-in' | 'user' | 'project' | 'plugin';

export interface SkillArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface SkillDefinition {
  name: string;
  displayName?: string;
  description: string;
  location: string;
  /** Base directory for skill-relative resources and branded skill-dir substitution. */
  skillRoot: string;
  body: string;
  disabled?: boolean;
  isBuiltin?: boolean;
  pluginName?: string;
  pluginPath?: string;
  pluginId?: string;
  hasUserSpecifiedDescription?: boolean;
  model?: string;
  allowedTools?: string[];
  whenToUse?: string;
  argumentHint?: string;
  arguments?: SkillArgument[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  effort?: EffortValue;
  context?: 'fork';
  agent?: string;
  hooks?: Record<string, unknown>;
  paths?: string[];
  shell?: FrontmatterShell;
  kind?: 'skill' | 'plugin-command';
  source?: SkillSource;
  resolvedPath?: string;
  alsoDefinedAt?: string[];
  getBody?: (
    args?: string,
    context?: { skillDir: string; sessionId: string },
  ) => Promise<string>;
  isEnabled?: () => boolean;
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  model?: string;
  allowedTools?: string[];
  whenToUse?: string;
  argumentHint?: string;
  arguments?: SkillArgument[];
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  effort?: EffortValue;
  context?: 'fork';
  agent?: string;
  hooks?: Record<string, unknown>;
  paths?: string[];
  shell?: FrontmatterShell;
}

export interface SkillLoadError {
  name?: string;
  filePath: string;
  message: string;
  configType: 'skill';
  source?: string;
  severity?: 'error' | 'warning';
}
