/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillDefinition } from '@qwen-code/resource';
import type { Config } from '../config/config.js';
import { isWorkflowAuthoringAvailable } from './workflow-authoring.js';
import { SKILL_TOOL_NAME } from '../tools/tool-names.js';
import type { WorkflowRegistryEntry } from './workflow-types.js';

export interface WorkflowSkillDefinition extends SkillDefinition {
  workflow: WorkflowRegistryEntry;
}

export interface WorkflowSkillBodyContext {
  skillDir: string;
  sessionId: string;
  toolNames?: readonly string[];
}

export function isWorkflowSkill(
  skill: SkillDefinition | null | undefined,
): skill is WorkflowSkillDefinition {
  return Boolean(skill && 'workflow' in skill);
}

/** The same command template serves slash and model-invoked Skill loading. */
export function buildWorkflowCommandPrompt(
  entry: WorkflowRegistryEntry,
  args: string,
  authoringAvailable = false,
): string {
  const phases = entry.phases
    ? '\n\nPhases:\n' +
      entry.phases
        .map(
          (phase) =>
            `- ${phase.title}${phase.detail ? `: ${phase.detail}` : ''}`,
        )
        .join('\n')
    : '';
  const trimmed = args.trim();
  const name = JSON.stringify(entry.name);
  const invocation = trimmed
    ? `{ name: ${name}, args: ${JSON.stringify(trimmed)} }`
    : `{ name: ${name} }`;
  const reference = authoringAvailable
    ? '\n\nIf the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.'
    : '';
  // Optional pre-existing extension, shown only for a selected schema-bearing workflow.
  const schema = entry.inputSchema
    ? `\n\nArgs schema: ${JSON.stringify(entry.inputSchema)}`
    : '';
  return `Run the "${entry.name}" workflow.\n\n${entry.description}${entry.whenToUse ? `\n\n${entry.whenToUse}` : ''}${phases}${schema}\n\nInvoke: Workflow(${invocation})${reference}`;
}

export function workflowToSkill(
  entry: WorkflowRegistryEntry,
  config: Config,
): WorkflowSkillDefinition {
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    hasUserSpecifiedDescription: true,
    location: entry.scriptPath ?? `workflow:${entry.name}`,
    skillRoot: config.getSessionArtifactProjectRoot(),
    source: entry.source,
    isBuiltin: entry.source === 'built-in',
    pluginName: entry.pluginName,
    pluginPath: entry.pluginPath,
    body: '',
    userInvocable: true,
    disableModelInvocation: entry.disableModelInvocation,
    workflow: entry,
    async getBody(args, context?: WorkflowSkillBodyContext) {
      const toolNames =
        context?.toolNames ??
        config
          .getToolRegistry()
          .getFunctionDeclarations(config.getModel())
          .flatMap((tool) => (tool.name ? [tool.name] : []));
      return buildWorkflowCommandPrompt(
        entry,
        args ?? '',
        isWorkflowAuthoringAvailable(config, toolNames),
      );
    },
  };
}

/** Match discovery to this request's callable tools, without a second catalog. */
export function getModelVisibleSkillsForTools(
  config: Config,
  toolNames: readonly string[],
  options: { isMainSession?: boolean } = {},
): SkillDefinition[] | null {
  if (!toolNames.includes(SKILL_TOOL_NAME)) return null;
  const manager = config.getSkillManager();
  if (!manager.isAdminEnabled()) return null;
  return manager.getModelVisibleSkills(options);
}
