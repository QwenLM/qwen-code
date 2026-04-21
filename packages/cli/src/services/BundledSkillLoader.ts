/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  appendToLastTextPart,
} from '@qwen-code/qwen-code-core';
import type { ICommandLoader } from './types.js';
import type {
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';

const debugLogger = createDebugLogger('BUNDLED_SKILL_LOADER');

/**
 * Loads bundled skills as slash commands, making them directly invocable
 * via /<skill-name> (e.g., /review).
 */
export class BundledSkillLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  private buildOnComplete(skill: SkillConfig, rawInvocation: string) {
    if (skill.name !== 'loop') {
      return undefined;
    }

    return async () => {
      const prompt = rawInvocation.trim();
      if (!prompt || prompt === '/loop') {
        return;
      }

      const basePrompt = skill.body.trimEnd();
      const followUpPrompt = `${basePrompt}\n\nImmediately execute the parsed prompt now instead of only scheduling it. The original user invocation was:\n${prompt}`;
      const geminiClient = this.config?.getGeminiClient?.();
      if (!geminiClient) {
        debugLogger.debug(
          'GeminiClient not available, skipping immediate /loop execution',
        );
        return;
      }

      await geminiClient.generateJson(followUpPrompt, {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: false,
        },
      });
    };
  }

  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    if (this.config?.getBareMode?.()) {
      debugLogger.debug('Bare mode enabled, skipping bundled skills');
      return [];
    }

    const skillManager = this.config?.getSkillManager();
    if (!skillManager) {
      debugLogger.debug('SkillManager not available, skipping bundled skills');
      return [];
    }

    try {
      const allSkills = await skillManager.listSkills({ level: 'bundled' });

      // Hide skills whose allowedTools require cron when cron is disabled
      const cronEnabled = this.config?.isCronEnabled() ?? false;
      const skills = allSkills.filter((skill) => {
        if (
          !cronEnabled &&
          skill.allowedTools?.some((t) => t.startsWith('cron_'))
        ) {
          debugLogger.debug(
            `Hiding skill "${skill.name}" because cron is not enabled`,
          );
          return false;
        }
        return true;
      });

      debugLogger.debug(
        `Loaded ${skills.length} bundled skill(s) as slash commands`,
      );

      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        kind: CommandKind.SKILL,
        source: 'bundled-skill' as const,
        sourceLabel: 'Skill',
        modelInvocable: !skill.disableModelInvocation,
        whenToUse: skill.whenToUse,
        action: async (context, _args): Promise<SlashCommandActionReturn> => {
          // Resolve template variables in skill body
          let body = skill.body;
          const modelId = this.config?.getModel()?.trim() || '';
          if (body.includes('{{model}}') || body.includes('YOUR_MODEL_ID')) {
            body = body.replaceAll('{{model}}', modelId);
            body = body.replaceAll('YOUR_MODEL_ID', modelId);
            // Prepend model identity as a top-level declaration so the LLM
            // cannot miss it even if it doesn't copy the template exactly.
            if (modelId) {
              body = `YOUR_MODEL_ID="${modelId}"\n\n${body}`;
            }
          }

          const content = context.invocation?.args
            ? appendToLastTextPart([{ text: body }], context.invocation.raw)
            : [{ text: body }];

          return {
            type: 'submit_prompt',
            content,
            onComplete: this.buildOnComplete(
              skill,
              context.invocation?.raw ?? '',
            ),
          };
        },
      }));
    } catch (error) {
      debugLogger.error('Failed to load bundled skills:', error);
      return [];
    }
  }
}
