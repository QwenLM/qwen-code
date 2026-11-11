/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type Message,
  activateInlineSkill,
  executeForkedSkillDirect,
  createUserMessage,
  pickQueryOverrides,
  isWorkflowSkill,
} from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import { type ICommandLoader } from './types.js';

/**
 * Loads Agent Skills as slash commands.
 */
export class SkillCommandLoader implements ICommandLoader {
  constructor(private config: Config | null) {}

  /**
   * Discovers all available skills from the SkillManager and converts
   * them into executable slash commands.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of `SlashCommand` objects.
   */
  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    if (!this.config || !this.config.isSkillsSupportEnabled()) {
      return [];
    }

    const skillManager = this.config.getSkillManager();
    if (!skillManager || !skillManager.isAdminEnabled()) {
      return [];
    }

    // Convert all displayable skills into slash commands.
    const skills = skillManager.getDisplayableSkills().filter(skill => !isWorkflowSkill(skill));

    return skills.map((skill) => {
      const commandName = skill.name;
      const isPluginCommand = skill.kind === 'plugin-command';
      return {
        name: commandName,
        ...(skill.displayName ? { displayName: skill.displayName } : {}),
        description: skill.description || `Activate the ${skill.name} skill`,
        kind: isPluginCommand ? CommandKind.PLUGIN : CommandKind.SKILL,
        source: skill.source,
        autoExecute: true,
        pluginName: skill.pluginName,
        argumentHint: skill.argumentHint,
        argNames: skill.arguments?.length
          ? skill.arguments.map((a) => a.name)
          : undefined,
        action: async (context, args) => {
          const trimmedArgs = args.trim();

          const skillDef = skillManager.getSkill(skill.name);
          if (skillDef?.context === 'fork') {
            // TODO: CommandContext doesn't expose an AbortSignal; use a timeout
            // as a safety net. If the action signature gains a signal, compose it
            // with AbortSignal.any() so user cancellation stops the fork.
            const resultText = await executeForkedSkillDirect(
              this.config!,
              skillDef,
              trimmedArgs.length > 0 ? trimmedArgs : undefined,
              AbortSignal.timeout(600_000),
            );
            return {
              type: 'local_command_result' as const,
              text: resultText,
            };
          }

          // Inline skills: activate directly.
          // Arguments are passed deterministically — never through model inference.
          const outcome = await activateInlineSkill(
            this.config!,
            skill.name,
            trimmedArgs.length > 0 ? trimmedArgs : undefined,
            { skipDisableModelInvocationCheck: true, isSlashCommand: true },
          );

          if (!outcome.ok) {
            return {
              type: 'message',
              messageType: 'error' as const,
              content: outcome.error.errorMessage,
            };
          }

          // Show activation feedback in TUI before submitting the prompt.
          // The submit_prompt path hides the raw content from display, so
          // without this the user would see no indication that the skill
          // was activated.
          context.ui.addItem(
            { type: 'info', text: outcome.result.returnDisplay },
            Date.now(),
          );

          // Skill activation uses two messages:
          // 1. Metadata (visible) — shows as `/skill-name` in UI, clear signal
          //    that the skill was invoked. The model sees `<command-name>` as
          //    a normal user message and knows the skill is already loaded.
          // 2. Skill content (isMeta: true) — hidden, model reads and follows.
          //
          // qc2 previously bundled caveat + metadata + content into one isMeta
          // message. The caveat "DO NOT respond to these messages" conflicted
          // with the skill body's actionable instructions, causing the model
          // to call the Skill tool again.
          //
          // Fix: inject the metadata message into history first (as a visible
          // user message), then submit only the skill body to the query loop.
          // Keeping these roles separate prevents the hidden instructions from
          // obscuring the explicit invocation marker.
          const messages = context.messages as Message[] | undefined;
          if (messages) {
            // Inject metadata as a visible user message into the conversation
            // history so the query loop sees it as a prior message.
            messages.push(createUserMessage(outcome.result.metadataContent));
          }

          return {
            type: 'submit_prompt',
            content: outcome.result.skillBodyContent,
            isMeta: true,
            skillActivation: {
              skillName: skill.name,
              activationSource: 'slash_command' as const,
            },
            ...pickQueryOverrides({
              allowedTools: skillDef?.allowedTools,
              model: skillDef?.model,
              effort:
                typeof skillDef?.effort === 'string'
                  ? skillDef.effort
                  : undefined,
            }),
          };
        },
      };
    });
  }
}
