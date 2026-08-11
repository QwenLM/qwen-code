/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Duck-typed view of SkillTool's loaded-skill tracking (mirrors the
 * `clearLoadedSkills` access pattern in clearCommand).
 */
interface SkillTrackingTool {
  getLoadedSkillNames(): ReadonlySet<string>;
  unloadSkills(names: Iterable<string>): void;
}

function getSkillTrackingTool(
  context: Parameters<NonNullable<SlashCommand['action']>>[0],
): SkillTrackingTool | undefined {
  const tool = context.services.config
    ?.getToolRegistry()
    ?.getAllTools()
    .find((candidate) => candidate.name === ToolNames.SKILL);
  if (tool && 'getLoadedSkillNames' in tool && 'unloadSkills' in tool) {
    return tool as unknown as SkillTrackingTool;
  }
  return undefined;
}

/**
 * Names of real (file-based) skills from the committed cache, or null when
 * the cache has not been committed yet (callers then skip the check rather
 * than block). The skill tool's command-executor fallback also tracks
 * model-invocable *command* names in loadedSkillNames — those are not skill
 * bodies and must not be unloadable.
 */
function getCachedSkillNames(
  context: Parameters<NonNullable<SlashCommand['action']>>[0],
): ReadonlySet<string> | null {
  const cached = context.services.config?.getSkillManager()?.getCachedSkills();
  if (!cached) return null;
  return new Set(cached.map((skill) => skill.name));
}

export const unskillCommand: SlashCommand = {
  name: 'unskill',
  get description() {
    return t(
      'Unload a loaded skill body from context, freeing its tokens for the rest of the session (costs one prompt-cache re-fill). The skill stays available and reloads in full on its next invocation.',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const skillName = context.invocation?.args?.trim() ?? '';
    if (!skillName) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('Usage: /unskill <skill-name>'),
      };
    }

    const config = context.services.config;
    const geminiClient = config?.getGeminiClient();
    if (!config || !geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const skillTool = getSkillTrackingTool(context);
    if (!skillTool) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Could not retrieve skill manager.'),
      };
    }

    const skillNames = getCachedSkillNames(context);
    if (skillNames && !skillNames.has(skillName)) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          '"{{name}}" is not a skill (it may be a model-invocable command); /unskill only unloads skill bodies.',
          { name: skillName },
        ),
      };
    }

    if (!skillTool.getLoadedSkillNames().has(skillName)) {
      // `--resume` restores history (bodies included) without the in-memory
      // tracking — fall back to locating the body before declaring it absent.
      if (!geminiClient.getChat().hasSkillBodyInHistory(skillName)) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('Skill "{{name}}" is not loaded in context.', {
            name: skillName,
          }),
        };
      }
    }

    const { cleared, tokensSaved } = geminiClient
      .getChat()
      .unloadSkillBody(skillName);
    // Un-track even when no body was found in history (e.g. it was already
    // blanked by compaction) — leaving the name tracked would keep the
    // dedup guard blocking a reload.
    skillTool.unloadSkills([skillName]);

    if (!cleared) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Skill "{{name}}" had no body left in context; tracking cleared so it can be reloaded.',
          { name: skillName },
        ),
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'Unloaded skill "{{name}}" (~{{tokens}} tokens freed). Invoke it again to reload.',
        { name: skillName, tokens: String(tokensSaved) },
      ),
    };
  },
  completion: async (context, partialArg) => {
    const skillTool = getSkillTrackingTool(context);
    if (!skillTool) {
      return null;
    }
    const skillNames = getCachedSkillNames(context);
    return [...skillTool.getLoadedSkillNames()]
      .filter(
        (name) =>
          (!skillNames || skillNames.has(name)) && name.startsWith(partialArg),
      )
      .sort();
  },
};
