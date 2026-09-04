/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Interactive command loading for the OpenTUI renderer.
 *
 * Builds the slash-command registry exactly like the ink
 * `useSlashCommandProcessor` does — same loader stack (MCP prompts, built-ins,
 * bundled skills, skill dirs, saved workflows, file commands) and
 * `CommandService` — and registers the model-invocable provider/executor on the
 * config. Command dispatch itself lives in `OpenTuiSlashDispatcher`
 * (`commands-dispatch.ts`), reached through `OpenTuiSlashGateway`.
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { SlashCommand } from '../commands/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { BundledSkillLoader } from '../../services/BundledSkillLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';
import { SavedWorkflowLoader } from '../../services/saved-workflow-loader.js';
import { SkillCommandLoader } from '../../services/SkillCommandLoader.js';
import { CommandService } from '../../services/CommandService.js';
import {
  appendUserPromptExpansionAdditionalContext,
  formatUserPromptExpansionBlockedMessage,
  serializeUserPromptExpansionPrompt,
} from '../../utils/userPromptExpansionHook.js';

function hasUserPromptExpansionHooks(config: Config | null): boolean {
  return (
    !!config &&
    !config.getDisableAllHooks?.() &&
    (config.hasHooksForEvent?.('UserPromptExpansion') ?? false)
  );
}

/**
 * Builds the interactive command list exactly like the ink processor does
 * (same loader order, same disabled-command denylist, same mode filter), and
 * registers the model-invocable commands provider/executor on the config
 * (ink loader-effect parity): without them the startup snapshot and per-turn
 * drain miss bundled skills, file commands, and MCP prompts, and SkillTool
 * cannot invoke model-invocable commands that are not file-based skills.
 */
export async function loadInteractiveCommands(
  config: Config | null,
  signal?: AbortSignal,
  settings?: LoadedSettings | null,
): Promise<readonly SlashCommand[]> {
  // Skill/MCP/project commands need the config fully initialized (the skill
  // manager is created in initialize()); without this /skills errors and
  // skill commands are missing from /-completion.
  try {
    await config?.initialize();
  } catch {
    /* proceed with partial commands */
  }
  const loaders = [
    new McpPromptLoader(config),
    new BuiltinCommandLoader(config),
    new BundledSkillLoader(config),
    new SkillCommandLoader(config),
    new SavedWorkflowLoader(config),
    new FileCommandLoader(config),
  ];
  const disabled = config?.getDisabledSlashCommands() ?? [];
  const commandService = await CommandService.create(
    loaders,
    signal ?? new AbortController().signal,
    disabled.length > 0 ? new Set(disabled) : undefined,
  );
  if (config) {
    config.setModelInvocableCommandsProvider(() =>
      commandService.getModelInvocableCommands().map((cmd) => ({
        name: cmd.name,
        description: cmd.modelDescription ?? cmd.description,
      })),
    );
    config.setModelInvocableCommandsExecutor(
      async (name: string, args: string = '') => {
        const commands = commandService.getModelInvocableCommands();
        const cmd = commands.find((c) => c.name === name);
        if (!cmd?.action) return null;
        // Build a minimal context; submit_prompt actions only need
        // invocation + services.config, not UI state.
        const minimalContext = {
          executionMode: 'non_interactive' as const,
          invocation: {
            raw: args ? `/${name} ${args}` : `/${name}`,
            name,
            args,
          },
          services: { config, settings: settings ?? null, logger: null },
        } as unknown as Parameters<typeof cmd.action>[0];
        const result = await cmd.action(minimalContext, args);
        if (!result || result.type !== 'submit_prompt') return null;
        const output = hasUserPromptExpansionHooks(config)
          ? await config
              .getHookSystem()
              ?.fireUserPromptExpansionEvent(
                name,
                args,
                serializeUserPromptExpansionPrompt(result.content),
                signal ?? new AbortController().signal,
              )
          : undefined;
        if (signal?.aborted) {
          return { error: 'Skill execution cancelled by user.' };
        }
        if (output) {
          const blockingError = output.getBlockingError();
          if (blockingError.blocked || output.shouldStopExecution()) {
            return {
              error: formatUserPromptExpansionBlockedMessage(
                blockingError.reason || output.getEffectiveReason(),
              ),
            };
          }
        }
        const content = appendUserPromptExpansionAdditionalContext(
          result.content,
          output?.getAdditionalContext(),
        );
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .map((p) =>
              typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''),
            )
            .join('');
        }
        return null;
      },
    );
  }
  return commandService.getCommandsForMode('interactive');
}
