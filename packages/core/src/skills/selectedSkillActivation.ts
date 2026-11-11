/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { SelectedSkillInput } from '../input/types.js';
import type { Message } from '../protocol/transcript/message.js';
import {
  createSystemMessage,
  createUserMessage,
} from '../protocol/transcript/conversions.js';
import { isWorkflowSkill } from '../workflows/workflow-skills.js';
import { activateInlineSkill } from './inlineSkillActivation.js';

export type DirectSkillActivationSource =
  | 'slash_command'
  | 'selected_skills';

export interface DirectSkillActivation {
  skillName: string;
  activationSource: DirectSkillActivationSource;
}

const MAX_SELECTED_SKILLS = 20;
const MAX_SKILL_NAME_LENGTH = 256;
const MAX_SKILL_ARGUMENTS_LENGTH = 65_536;

export class SelectedSkillActivationError extends Error {
  readonly code = 'INVALID_SELECTED_SKILLS';

  constructor(message: string) {
    super(message);
    this.name = 'SelectedSkillActivationError';
  }
}

export interface SelectedSkillActivationResult {
  messages: Message[];
  skillActivations: DirectSkillActivation[];
  allowedTools?: string[];
  model?: string;
  effort?: string;
}

/**
 * Activates user-selected inline Skills through the same implementation used
 * by slash commands and model tool calls. Selection-wide validation happens
 * first. The first Skill owns the prompt and fails the turn if it cannot load;
 * later Skills are additive, so their failures are reported while remaining
 * selections continue in order.
 */
export async function activateSelectedSkills(
  config: Config,
  selectedSkills: readonly SelectedSkillInput[],
): Promise<SelectedSkillActivationResult> {
  const selections = normalizeSelections(selectedSkills);
  if (selections.length === 0) return { messages: [], skillActivations: [] };
  if (!config.isSkillsSupportEnabled()) {
    throw new SelectedSkillActivationError('Skills are disabled for this session.');
  }

  const skillManager = config.getSkillManager();
  if (!skillManager.isAdminEnabled()) {
    throw new SelectedSkillActivationError('Skills are disabled by policy.');
  }

  const resolved = selections.map((selection) => {
    const skill = skillManager.getSkill(selection.name);
    if (!skill || skill.disabled || skill.userInvocable === false) {
      throw new SelectedSkillActivationError(
        `Selected skill "${selection.name}" is unavailable.`,
      );
    }
    if (skill.context === 'fork' || isWorkflowSkill(skill)) {
      throw new SelectedSkillActivationError(
        `Selected skill "${skill.name}" cannot be combined with other prompt input. Invoke it as a slash command instead.`,
      );
    }
    return { selection, skill };
  });

  const messages: Message[] = [];
  const skillActivations: DirectSkillActivation[] = [];
  const allowedTools = new Set<string>();
  let model: string | undefined;
  let effort: string | undefined;
  for (const [index, { selection, skill }] of resolved.entries()) {
    let outcome: Awaited<ReturnType<typeof activateInlineSkill>>;
    try {
      outcome = await activateInlineSkill(
        config,
        skill.name,
        selection.arguments,
        {
          skipDisableModelInvocationCheck: true,
          isSlashCommand: true,
        },
      );
    } catch (error) {
      if (index === 0) throw error;
      messages.push(createStackedSkillFailureMessage(skill.name, error));
      continue;
    }
    if (!outcome.ok) {
      const error = new SelectedSkillActivationError(
        outcome.error.errorMessage,
      );
      if (index === 0) throw error;
      messages.push(createStackedSkillFailureMessage(skill.name, error));
      continue;
    }
    messages.push(
      createUserMessage(outcome.result.metadataContent),
      createUserMessage(outcome.result.skillBodyContent, { isMeta: true }),
    );
    skillActivations.push({
      skillName: skill.name,
      activationSource: 'selected_skills',
    });
    for (const tool of skill.allowedTools ?? []) allowedTools.add(tool);
    if (skill.model) model = skill.model;
    if (skill.effort !== undefined) effort = String(skill.effort);
  }

  return {
    messages,
    skillActivations,
    ...(allowedTools.size > 0 ? { allowedTools: [...allowedTools] } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function normalizeSelections(
  selectedSkills: readonly SelectedSkillInput[],
): SelectedSkillInput[] {
  if (!Array.isArray(selectedSkills) || selectedSkills.length > MAX_SELECTED_SKILLS) {
    throw new SelectedSkillActivationError(
      `selected_skills must contain at most ${MAX_SELECTED_SKILLS} entries.`,
    );
  }
  const names = new Set<string>();
  return selectedSkills.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new SelectedSkillActivationError(
        `selected_skills[${index}] must be an object.`,
      );
    }
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > MAX_SKILL_NAME_LENGTH) {
      throw new SelectedSkillActivationError(
        `selected_skills[${index}].name must be a non-empty string no longer than ${MAX_SKILL_NAME_LENGTH} characters.`,
      );
    }
    const key = name.toLowerCase();
    if (names.has(key)) {
      throw new SelectedSkillActivationError(
        `Selected skill "${name}" appears more than once.`,
      );
    }
    names.add(key);
    const args = value.arguments;
    if (args !== undefined && typeof args !== 'string') {
      throw new SelectedSkillActivationError(
        `selected_skills[${index}].arguments must be a string.`,
      );
    }
    if (args !== undefined && args.length > MAX_SKILL_ARGUMENTS_LENGTH) {
      throw new SelectedSkillActivationError(
        `selected_skills[${index}].arguments is too long.`,
      );
    }
    return { name, ...(args === undefined ? {} : { arguments: args }) };
  });
}

function createStackedSkillFailureMessage(
  skillName: string,
  error: unknown,
): Message {
  const detail = error instanceof Error ? error.message : String(error);
  return createSystemMessage(
    'informational',
    `Stacked skill /${skillName} failed to load: ${detail}`,
    'error',
  );
}
