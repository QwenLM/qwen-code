/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  appendToLastTextPart,
  buildSkillLlmContent,
  applySkillAllowedTools,
} from '@qwen-code/qwen-code-core';
import { dirname } from 'node:path';
import {
  AUTOFIX_CRON,
  AUTOFIX_USAGE,
  buildAutofixImmediatePrompt,
  formatAutofixTick,
  matchingAutofixWatchers,
  resolveCurrentAutofixPullRequest,
  watcherSummary,
  type AutofixMode,
  type CurrentAutofixPullRequestResult,
} from '../utils/autofix.js';
import type { ICommandLoader } from './types.js';
import type {
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import { t } from '../i18n/index.js';
import {
  writeSkillArgs,
  clearSkillArgs,
  staleArgsWarning,
  skillArgsNote,
  skillArgsPath,
} from './skill-args-file.js';

const debugLogger = createDebugLogger('BUNDLED_SKILL_LOADER');

export interface BundledSkillLoaderOptions {
  resolveCurrentAutofixPullRequest?: (
    config: Config,
  ) => Promise<CurrentAutofixPullRequestResult>;
}

/**
 * Loads bundled skills as slash commands, making them directly invocable
 * via /<skill-name> (e.g., /review).
 */
export class BundledSkillLoader implements ICommandLoader {
  constructor(
    private readonly config: Config | null,
    private readonly options: BundledSkillLoaderOptions = {},
  ) {}

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
      const cronVisible = allSkills.filter((skill) => {
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

      // Apply user-controlled `skills.disabled` filter HERE so disabling a
      // bundled skill cannot accidentally hide a same-named built-in
      // command or MCP prompt (which would happen if we routed this
      // through `CommandService`'s global denylist instead).
      const disabled =
        this.config?.getDisabledSkillNames() ?? new Set<string>();
      const skills = cronVisible.filter(
        (skill) => !disabled.has(skill.name.toLowerCase()),
      );

      debugLogger.debug(
        `Loaded ${skills.length} bundled skill(s) as slash commands; ${cronVisible.length - skills.length} hidden by skills.disabled`,
      );

      return skills.map((skill) => {
        const runAutofix = async (
          context: Parameters<NonNullable<SlashCommand['action']>>[0],
        ): Promise<SlashCommandActionReturn | null> => {
          if (skill.name !== 'autofix') return null;
          const input = context.invocation?.args.trim() ?? '';
          const match =
            /^(status|off|on(?: (propose-only|auto-commit|auto-push))?)$/.exec(
              input,
            );
          if (!match) {
            return {
              type: 'message',
              messageType: 'error',
              content: AUTOFIX_USAGE,
            };
          }
          const resolved = await (
            this.options.resolveCurrentAutofixPullRequest ??
            resolveCurrentAutofixPullRequest
          )(this.config!);
          if (resolved.kind === 'error') {
            return {
              type: 'message',
              messageType: 'error',
              content: resolved.message,
            };
          }
          const { pullRequest, repo } = resolved.value;
          const scheduler = this.config!.getCronScheduler();
          const watchers = matchingAutofixWatchers(
            scheduler.list(),
            repo,
            pullRequest.number,
          );

          if (match[1] === 'status') {
            return {
              type: 'message',
              messageType: 'info',
              content: [
                `PR ${repo}#${pullRequest.number}: ${pullRequest.url}`,
                watcherSummary(watchers[0]),
                `CI: ${pullRequest.checks}`,
                `Review: ${pullRequest.reviewDecision ?? 'no aggregate decision'}`,
              ].join('\n'),
            };
          }

          if (match[1] === 'off') {
            const failures: string[] = [];
            for (const watcher of watchers) {
              try {
                if (!(await scheduler.delete(watcher.job.id))) {
                  failures.push(watcher.job.id);
                }
              } catch {
                failures.push(watcher.job.id);
              }
            }
            const remaining = matchingAutofixWatchers(
              scheduler.list(),
              repo,
              pullRequest.number,
            );
            return remaining.length === 0 && failures.length === 0
              ? {
                  type: 'message',
                  messageType: 'info',
                  content: `Autofix watcher is off for ${repo}#${pullRequest.number}.`,
                }
              : {
                  type: 'message',
                  messageType: 'error',
                  content: `Autofix watcher could not be fully disabled for ${repo}#${pullRequest.number}. Failed jobs: ${[...new Set([...failures, ...remaining.map((watcher) => watcher.job.id)])].join(', ')}`,
                };
          }

          if (watchers.length > 0) {
            return {
              type: 'message',
              messageType: 'info',
              content: `Autofix watcher is already on for ${repo}#${pullRequest.number}. ${watcherSummary(watchers[0])}`,
            };
          }
          if (scheduler.disabled) {
            return {
              type: 'message',
              messageType: 'error',
              content:
                'Autofix cannot start because scheduled tasks are disabled for this session. Restart Qwen Code and try again.',
            };
          }

          const mode = (match[2] ?? 'propose-only') as AutofixMode;
          let job;
          try {
            job = scheduler.create(
              AUTOFIX_CRON,
              formatAutofixTick(repo, pullRequest.number, mode, 0, 0),
              true,
            );
          } catch (error) {
            return {
              type: 'message',
              messageType: 'error',
              content: `Autofix could not start its watcher: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          applySkillAllowedTools(
            this.config?.getPermissionManager(),
            skill.allowedTools,
          );
          return {
            type: 'submit_prompt',
            content: [
              {
                text: buildAutofixImmediatePrompt(skill, {
                  job,
                  repo,
                  pr: pullRequest.number,
                  mode,
                  rounds: 0,
                  infraReruns: 0,
                }),
              },
            ],
          };
        };

        return {
          name: skill.name,
          description: skill.description,
          modelDescription: skill.description,
          kind: CommandKind.SKILL,
          source: 'bundled-skill' as const,
          sourceLabel: t('Skill'),
          userInvocable: skill.userInvocable ?? true,
          modelInvocable: !skill.disableModelInvocation,
          argumentHint: skill.argumentHint,
          whenToUse: skill.whenToUse,
          skillDetail: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            level: skill.level,
          },
          action: async (context, _args): Promise<SlashCommandActionReturn> => {
            const autofixResult = await runAutofix(context);
            if (autofixResult) return autofixResult;
            // Auto-approve the skill's declared allowedTools before its body is submitted.
            applySkillAllowedTools(
              this.config?.getPermissionManager(),
              skill.allowedTools,
            );

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

            const skillPrompt = buildSkillLlmContent(
              dirname(skill.filePath),
              body,
            );

            // Write the arguments down before the model gets a say in them. A
            // skill that needs them as data used to ask the model to copy them
            // into a file, and `/review 6771` was duly copied as `--effort high`
            // — an example lifted out of the skill's own docs. The parser then did
            // its job perfectly on the wrong input, reviewed the local working
            // tree instead of the pull request, found it clean, and reported
            // "no changes to review".
            const rawArgs = context.invocation?.args ?? '';
            let content;
            if (rawArgs) {
              content = appendToLastTextPart(
                [{ text: skillPrompt }],
                context.invocation!.raw +
                  (writeSkillArgs(skill.name, rawArgs)
                    ? skillArgsNote(skillArgsPath(skill.name), rawArgs)
                    : ''),
              );
            } else {
              // A bare invocation records no arguments — and must erase any record
              // an earlier argument-bearing run left, or that run's posting
              // authority is inherited by this one. If the erase FAILS, the stale
              // record is still on disk and `submit` will still trust it, so the
              // skill is told: silence here would let a `/review 6771 --comment`
              // from earlier in the session authorise this bare run's post.
              content = [{ text: skillPrompt }];
              if (!clearSkillArgs(skill.name)) {
                content = appendToLastTextPart(content, staleArgsWarning());
              }
            }

            return {
              type: 'submit_prompt',
              content,
            };
          },
        };
      });
    } catch (error) {
      debugLogger.error('Failed to load bundled skills:', error);
      return [];
    }
  }
}
