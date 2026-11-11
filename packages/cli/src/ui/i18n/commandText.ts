/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiLocale } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { I18nService } from '@qwen-code/core';

export const BUILTIN_COMMAND_DESCRIPTION_KEYS = {
  about: 'commands.builtin.about.description',
  agents: 'commands.builtin.agents.description',
  'agents reload': 'commands.builtin.agents.reload.description',
  btw: 'commands.builtin.btw.description',
  branch: 'commands.builtin.branch.description',
  subtask: 'commands.builtin.subtask.description',
  clear: 'commands.builtin.clear.description',
  new: 'commands.builtin.new.description',
  commands: 'commands.builtin.commands.description',
  compact: 'commands.builtin.compact.description',
  copy: 'commands.builtin.copy.description',
  editor: 'commands.builtin.editor.description',
  effort: 'commands.builtin.effort.description',
  export: 'commands.builtin.export.description',
  help: 'commands.builtin.help.description',
  shortcuts: 'commands.builtin.shortcuts.description',
  hooks: 'commands.builtin.hooks.description',
  diff: 'commands.builtin.diff.description',
  review: 'commands.builtin.review.description',
  init: 'commands.builtin.init.description',
  mcp: 'commands.builtin.mcp.description',
  'mcp reload': 'commands.builtin.mcp.reload.description',
  memory: 'commands.builtin.memory.description',
  'memory manage': 'commands.builtin.memory.manage.description',
  model: 'commands.builtin.model.description',
  'marketplace add': 'commands.builtin.marketplace.add.description',
  'marketplace list': 'commands.builtin.marketplace.list.description',
  'marketplace remove': 'commands.builtin.marketplace.remove.description',
  'marketplace update': 'commands.builtin.marketplace.update.description',
  plugins: 'commands.builtin.plugins.description',
  'plugins install': 'commands.builtin.plugins.install.description',
  'plugins uninstall': 'commands.builtin.plugins.uninstall.description',
  'plugins enable': 'commands.builtin.plugins.enable.description',
  'plugins disable': 'commands.builtin.plugins.disable.description',
  'plugins update': 'commands.builtin.plugins.update.description',
  'plugins validate': 'commands.builtin.plugins.validate.description',
  'plugins marketplace': 'commands.builtin.plugins.marketplace.description',
  'plugins marketplace add':
    'commands.builtin.plugins.marketplace.add.description',
  'plugins marketplace list':
    'commands.builtin.plugins.marketplace.list.description',
  'plugins marketplace remove':
    'commands.builtin.plugins.marketplace.remove.description',
  'plugins marketplace update':
    'commands.builtin.plugins.marketplace.update.description',
  'plugins reload': 'commands.builtin.plugins.reload.description',
  plan: 'commands.builtin.plan.description',
  'plan copy': 'commands.builtin.plan.copy.description',
  'plan open': 'commands.builtin.plan.open.description',
  goal: 'commands.builtin.goal.description',
  'goal status': 'commands.builtin.goal.status.description',
  'goal clear': 'commands.builtin.goal.clear.description',
  'goal pause': 'commands.builtin.goal.pause.description',
  'goal resume': 'commands.builtin.goal.resume.description',
  crontab: 'commands.builtin.crontab.description',
  permissions: 'commands.builtin.permissions.description',
  'permissions list': 'commands.builtin.permissions.list.description',
  peers: 'commands.builtin.peers.description',
  profile: 'commands.builtin.profile.description',
  quit: 'commands.builtin.quit.description',
  rewind: 'commands.builtin.rewind.description',
  continue: 'commands.builtin.continue.description',
  rename: 'commands.builtin.rename.description',
  resume: 'commands.builtin.resume.description',
  usage: 'commands.builtin.usage.description',
  status: 'commands.builtin.status.description',
  'add-dir': 'commands.builtin.add-dir.description',
  'add-dir list': 'commands.builtin.add-dir.list.description',
  context: 'commands.builtin.context.description',
  'context-window': 'commands.builtin.context-window.description',
  theme: 'commands.builtin.theme.description',
  tools: 'commands.builtin.tools.description',
  skills: 'commands.builtin.skills.description',
  'skills link': 'commands.builtin.skills.link.description',
  'skills reload': 'commands.builtin.skills.reload.description',
  settings: 'commands.builtin.settings.description',
  statusline: 'commands.builtin.statusline.description',
  tasks: 'commands.builtin.tasks.description',
  workflows: 'commands.builtin.workflows.description',
  vim: 'commands.builtin.vim.description',
  'terminal-setup': 'commands.builtin.terminal-setup.description',
  'release-notes': 'commands.builtin.release-notes.description',
} as const satisfies Readonly<Record<string, string>>;

export function resolveCommandDescription(
  command: SlashCommand,
  canonicalPath: string,
  t: I18nService['get'],
  locale: UiLocale,
  keys: Readonly<Record<string, string>> = BUILTIN_COMMAND_DESCRIPTION_KEYS,
): string {
  if (command.kind !== CommandKind.BUILT_IN || locale === 'en') {
    return command.description;
  }
  const key = keys[canonicalPath];
  return key ? t(key) : command.description;
}

export function getMissingBuiltinCommandDescriptionPaths(
  commands: readonly SlashCommand[],
  parentPath = '',
  keys: Readonly<Record<string, string>> = BUILTIN_COMMAND_DESCRIPTION_KEYS,
): string[] {
  const missing: string[] = [];
  for (const command of commands) {
    const path = parentPath ? `${parentPath} ${command.name}` : command.name;
    if (
      !command.hidden &&
      command.kind === CommandKind.BUILT_IN &&
      !(path in keys)
    ) {
      missing.push(path);
    }
    if (command.subCommands) {
      missing.push(
        ...getMissingBuiltinCommandDescriptionPaths(
          command.subCommands,
          path,
          keys,
        ),
      );
    }
  }
  return missing;
}
