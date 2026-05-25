/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandCompletionItem,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType, type HistoryItemSkillsList } from '../types.js';
import { t } from '../../i18n/index.js';
import { AsyncFzf } from 'fzf';
import type { SkillConfig } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  normalizeSkillPriority,
} from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';

const debugLogger = createDebugLogger('SKILLS_COMMAND');

const SUBCOMMAND_NAMES = ['enable', 'disable'] as const;

function getDisabledSet(context: CommandContext): ReadonlySet<string> {
  const list = context.services.settings?.merged.skills?.disabled ?? [];
  return new Set(list.map((n) => n.trim().toLowerCase()).filter(Boolean));
}

function getWorkspaceDisabled(context: CommandContext): string[] {
  return (
    context.services.settings?.forScope(SettingScope.Workspace).settings.skills
      ?.disabled ?? []
  );
}

function emitTrustError(context: CommandContext, action: string): void {
  context.ui.addItem(
    {
      type: MessageType.ERROR,
      text: t(
        'Cannot {{action}} skill: workspace is untrusted, and workspace ' +
          'settings are ignored by the merged config. Run /trust first to ' +
          'persist skills changes here, or edit ~/.qwen/settings.json ' +
          'directly to manage skills at user scope.',
        { action },
      ),
    },
    Date.now(),
  );
}

function ensureLiveRefreshAvailable(context: CommandContext): boolean {
  // `supportedModes` filtering at CommandService level is top-level only,
  // so `/skills disable foo` typed inside ACP/non-interactive mode would
  // still dispatch the subcommand action. Explicit guard here so we don't
  // silently write settings without refreshing the in-session state.
  const mode = context.executionMode;
  if (mode && mode !== 'interactive') {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t(
          '/skills enable/disable is interactive-only. In ACP/non-interactive ' +
            'mode the in-session command surface cannot be rebuilt, so a ' +
            'toggle would not take effect until the next session. Edit ' +
            '~/.qwen/settings.json (user) or .qwen/settings.json (workspace) ' +
            'directly instead.',
        ),
      },
      Date.now(),
    );
    return false;
  }
  return true;
}

async function refreshAfterChange(context: CommandContext): Promise<void> {
  // ORDER MATTERS — must NOT be Promise.all.
  //
  // `reloadCommands` rebuilds CommandService and, inside the same effect,
  // re-registers `modelInvocableCommandsProvider` on Config with a closure
  // over the FRESH CommandService instance. `notifyConfigChanged` triggers
  // `SkillTool.refreshSkills`, which calls that provider to populate
  // `modelInvocableCommands`.
  //
  // If we ran them in parallel, refreshSkills could fire while the
  // provider closure still pointed at the previous CommandService — the
  // disabled skill would still appear as a command-form entry inside
  // `<available_skills>`, leaking through `fileBasedSkillNames`'s exclusion
  // path. Strict serialization closes that race.
  await context.ui.reloadCommands();
  const skillManager = context.services.config?.getSkillManager();
  if (skillManager) {
    await skillManager.notifyConfigChanged();
  }
}

const disableSubCommand: SlashCommand = {
  name: 'disable',
  get description() {
    return t('Disable a skill at workspace scope.');
  },
  kind: CommandKind.BUILT_IN,
  // Interactive only. ACP/non-interactive `context.ui.reloadCommands` is a
  // no-op (see `nonInteractiveUi.ts`), so the in-session CommandService
  // would not rebuild and the model would keep seeing the disabled skill
  // via the stale `modelInvocableCommandsProvider` closure. Rather than
  // pretend live refresh works there, we expose this only where it does;
  // ACP users edit `~/.qwen/settings.json` (user) or `.qwen/settings.json`
  // (workspace) directly and the next session picks the change up.
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<void | SlashCommandActionReturn> => {
    if (!ensureLiveRefreshAvailable(context)) return;
    const settings = context.services.settings;
    const skillManager = context.services.config?.getSkillManager();
    if (!settings || !skillManager) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Skills manager is not available in this context.'),
        },
        Date.now(),
      );
      return;
    }

    const name = (args ?? '').trim().split(/\s+/)[0] ?? '';
    if (!name) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Usage: /skills disable <name>'),
        },
        Date.now(),
      );
      return;
    }

    const allSkills = await skillManager.listSkills();
    const matched = allSkills.find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    if (!matched) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Unknown skill: {{name}}', { name }),
        },
        Date.now(),
      );
      return;
    }

    if (!settings.isTrusted) {
      emitTrustError(context, t('disable'));
      return;
    }

    const current = getWorkspaceDisabled(context);
    const lower = matched.name.toLowerCase();
    if (current.some((n) => n.toLowerCase() === lower)) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Skill "{{name}}" is already disabled at workspace scope.', {
            name: matched.name,
          }),
        },
        Date.now(),
      );
      return;
    }

    const next = [...current, matched.name];
    settings.setValue(SettingScope.Workspace, 'skills.disabled', next);
    await refreshAfterChange(context);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Disabled skill "{{name}}" at workspace scope.', {
          name: matched.name,
        }),
      },
      Date.now(),
    );
  },
  completion: async (
    context: CommandContext,
    partialArg: string,
  ): Promise<CommandCompletionItem[]> => {
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) return [];
    const all = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    // Suggest currently-enabled skills (so the user can disable them).
    const candidates = all.filter((s) => !disabled.has(s.name.toLowerCase()));
    return matchSkillCandidates(candidates, partialArg);
  },
};

const enableSubCommand: SlashCommand = {
  name: 'enable',
  get description() {
    return t('Re-enable a skill (workspace scope).');
  },
  kind: CommandKind.BUILT_IN,
  // Interactive only — see `disableSubCommand` for why ACP is excluded.
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<void | SlashCommandActionReturn> => {
    if (!ensureLiveRefreshAvailable(context)) return;
    const settings = context.services.settings;
    const skillManager = context.services.config?.getSkillManager();
    if (!settings || !skillManager) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Skills manager is not available in this context.'),
        },
        Date.now(),
      );
      return;
    }

    const name = (args ?? '').trim().split(/\s+/)[0] ?? '';
    if (!name) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Usage: /skills enable <name>'),
        },
        Date.now(),
      );
      return;
    }

    const allSkills = await skillManager.listSkills();
    const matched = allSkills.find(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    if (!matched) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Unknown skill: {{name}}', { name }),
        },
        Date.now(),
      );
      return;
    }

    if (!settings.isTrusted) {
      emitTrustError(context, t('enable'));
      return;
    }

    const current = getWorkspaceDisabled(context);
    const lower = matched.name.toLowerCase();
    const next = current.filter((n) => n.toLowerCase() !== lower);
    const removedFromWorkspace = next.length !== current.length;

    if (removedFromWorkspace) {
      settings.setValue(
        SettingScope.Workspace,
        'skills.disabled',
        next.length > 0 ? next : undefined,
      );
      await refreshAfterChange(context);
    }

    // UNION-merge means workspace cannot remove names listed by
    // systemDefaults / user / system scopes. The merged check decides what
    // message we ultimately emit — we want the user to see a single,
    // unambiguous outcome rather than INFO + WARNING pairs that fight
    // each other.
    const stillDisabled = (settings.merged.skills?.disabled ?? []).some(
      (n) => n.toLowerCase() === lower,
    );

    if (stillDisabled) {
      context.ui.addItem(
        {
          type: MessageType.WARNING,
          text: removedFromWorkspace
            ? t(
                'Removed "{{name}}" from workspace skills.disabled, but it ' +
                  'remains disabled at a higher scope ' +
                  '(systemDefaults/user/system). To fully enable it, remove ' +
                  'it from ~/.qwen/settings.json (user) or contact your ' +
                  'administrator.',
                { name: matched.name },
              )
            : t(
                'Skill "{{name}}" is disabled at a higher scope ' +
                  '(systemDefaults/user/system) and cannot be enabled at ' +
                  'workspace scope. Remove it from ~/.qwen/settings.json ' +
                  '(user) or contact your administrator.',
                { name: matched.name },
              ),
        },
        Date.now(),
      );
    } else if (removedFromWorkspace) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Enabled skill "{{name}}".', { name: matched.name }),
        },
        Date.now(),
      );
    } else {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Skill "{{name}}" is already enabled.', {
            name: matched.name,
          }),
        },
        Date.now(),
      );
    }
  },
  completion: async (
    context: CommandContext,
    partialArg: string,
  ): Promise<CommandCompletionItem[]> => {
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) return [];
    const all = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    // Suggest currently-disabled skills (so the user can re-enable them).
    const candidates = all.filter((s) => disabled.has(s.name.toLowerCase()));
    return matchSkillCandidates(candidates, partialArg);
  },
};

export const skillsCommand: SlashCommand = {
  name: 'skills',
  get description() {
    return t('Manage skills (enable / disable, search).');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  subCommands: [enableSubCommand, disableSubCommand],
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<void | SlashCommandActionReturn> => {
    const rawArgs = args?.trim() ?? '';
    const [skillName = ''] = rawArgs.split(/\s+/);

    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Could not retrieve skill manager.'),
        },
        Date.now(),
      );
      return;
    }

    // Bare `/skills` opens the manage dialog directly — single entry,
    // search/sort/toggle all live there. In ACP / non-interactive mode the
    // dialog never renders (DialogManager is part of the interactive UI),
    // so we fall back to the original list behavior so users in those
    // contexts still get something useful from the bare command.
    if (!skillName) {
      if (context.executionMode === 'interactive') {
        return { type: 'dialog', dialog: 'skills_manage' };
      }
      const skills = await skillManager.listSkills();
      const disabled = getDisabledSet(context);
      const visibleSkills = skills.filter(
        (s) => !disabled.has(s.name.toLowerCase()),
      );
      if (visibleSkills.length === 0) {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text:
              skills.length === 0
                ? t('No skills are currently available.')
                : t(
                    'All available skills are disabled. Edit ~/.qwen/settings.json or .qwen/settings.json (skills.disabled) to re-enable.',
                  ),
          },
          Date.now(),
        );
        return;
      }
      const sortedSkills = [...visibleSkills].sort(
        (a, b) =>
          normalizeSkillPriority(b.priority) -
            normalizeSkillPriority(a.priority) || a.name.localeCompare(b.name),
      );
      const skillsListItem: HistoryItemSkillsList = {
        type: MessageType.SKILLS_LIST,
        skills: sortedSkills.map((skill) => ({ name: skill.name })),
      };
      context.ui.addItem(skillsListItem, Date.now());
      return;
    }

    // `/skills <name>` invocation path — works in any mode.
    const skills = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    const normalizedName = skillName.toLowerCase();
    const matched = skills.find(
      (skill) => skill.name.toLowerCase() === normalizedName,
    );

    if (!matched) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Unknown skill: {{name}}', { name: skillName }),
        },
        Date.now(),
      );
      return;
    }

    if (disabled.has(normalizedName)) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Skill "{{name}}" is disabled. Re-enable it via /skills (manage dialog) or remove it from skills.disabled.',
            { name: matched.name },
          ),
        },
        Date.now(),
      );
      return;
    }

    const rawInput = context.invocation?.raw ?? `/skills ${rawArgs}`;
    return {
      type: 'submit_prompt',
      content: [{ text: rawInput }],
    };
  },
  completion: async (
    context: CommandContext,
    partialArg: string,
  ): Promise<CommandCompletionItem[]> => {
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) return [];

    const partial = partialArg.trim().toLowerCase();
    // Prepend the subcommand suggestions so `/skills <tab>` can discover
    // `enable` / `disable`. Without this the parent's `completion` fully
    // shadows subCommands in `useSlashCompletion`'s argument-completion
    // path. The `manage` subcommand was removed — bare `/skills` now
    // opens the dialog directly. Filter by prefix so `/skills en<tab>`
    // narrows to `enable`.
    const subCommandSuggestions: CommandCompletionItem[] = [
      {
        value: 'enable',
        description: t('Re-enable a previously disabled skill'),
      },
      {
        value: 'disable',
        description: t('Disable a skill at workspace scope'),
      },
    ].filter((s) => !partial || s.value.startsWith(partial));

    const skills = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    const visible = skills.filter((s) => !disabled.has(s.name.toLowerCase()));
    const skillSuggestions = await matchSkillCandidates(visible, partialArg);
    // Drop any skill suggestion that collides with a subcommand name we
    // already added — keeps `/skills enable` resolving as "subcommand"
    // and avoids confusing duplicate completion entries.
    const reserved = new Set<string>(SUBCOMMAND_NAMES);
    return [
      ...subCommandSuggestions,
      ...skillSuggestions.filter((s) => !reserved.has(s.value)),
    ];
  },
};

async function matchSkillCandidates(
  skills: SkillConfig[],
  query: string,
): Promise<CommandCompletionItem[]> {
  const matched = await getSkillMatches(skills, query);
  return matched.map((skill) => ({
    value: skill.name,
    description: skill.description,
  }));
}

async function getSkillMatches(
  skills: SkillConfig[],
  query: string,
): Promise<SkillConfig[]> {
  if (!query) {
    return skills;
  }

  const names = skills.map((skill) => skill.name);
  const skillMap = new Map(skills.map((skill) => [skill.name, skill]));

  try {
    const fzf = new AsyncFzf(names, {
      fuzzy: 'v2',
      casing: 'case-insensitive',
    });
    const results = (await fzf.find(query)) as Array<{ item: string }>;
    return results
      .map((result) => skillMap.get(result.item))
      .filter((skill): skill is SkillConfig => !!skill);
  } catch (error) {
    debugLogger.error('[skillsCommand] Fuzzy match failed:', error);
    const lowerQuery = query.toLowerCase();
    return skills.filter((skill) =>
      skill.name.toLowerCase().startsWith(lowerQuery),
    );
  }
}
