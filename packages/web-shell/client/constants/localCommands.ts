import type { CommandInfo } from '../adapters/types';
import type { useI18n } from '../i18n';

type Translate = ReturnType<typeof useI18n>['t'];

/**
 * Commands that should always appear in the slash-command completion menu,
 * regardless of what ACP sends (ACP filters most BUILT_IN commands to
 * 'interactive' mode only). These are merged with ACP-provided commands,
 * with ACP taking precedence on duplicates.
 */
export function getLocalCommands(t: Translate): CommandInfo[] {
  return [
    { name: 'help', description: t('local.help') },
    {
      name: 'theme',
      description: t('local.theme'),
      argumentHint: 'light|dark',
      subcommands: ['light', 'dark'],
    },
    {
      name: 'language',
      description: t('local.language'),
      argumentHint: 'ui [en|zh-CN]',
      subcommands: ['ui'],
    },
    { name: 'plan', description: t('local.plan'), argumentHint: '<prompt>' },
    {
      name: 'copy',
      description: t('local.copy'),
      argumentHint: '[code|<lang>|latex|inline-latex] [index]',
    },
    { name: 'release', description: t('local.release') },
    { name: 'mode', description: t('local.mode'), argumentHint: '<mode>' },
    {
      name: 'approval-mode',
      description: t('local.approvalMode'),
      argumentHint: '<mode>',
    },
    {
      name: 'model',
      description: t('local.model'),
      argumentHint: '[--fast] [<model>]',
    },
    { name: 'mcp', description: t('local.mcp') },
    { name: 'skills', description: t('local.skills') },
    { name: 'tools', description: t('local.tools') },
    {
      name: 'memory',
      description: t('local.memory'),
      argumentHint: 'show|add|refresh',
    },
    {
      name: 'agents',
      description: t('local.agents'),
      argumentHint: 'manage|create user|create project',
    },
    { name: 'clear', description: t('local.clear') },
    { name: 'new', description: t('local.new') },
    { name: 'reset', description: t('local.reset') },
    {
      name: 'rename',
      description: t('local.rename'),
      argumentHint: '[--auto] [<name>]',
    },
    {
      name: 'resume',
      description: t('local.resume'),
      argumentHint: '<session-id>',
    },
  ];
}
