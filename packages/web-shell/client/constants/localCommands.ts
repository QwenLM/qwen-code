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
  const commands: CommandInfo[] = [
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
      name: 'btw',
      description: t('local.btw'),
      argumentHint: '<your question>',
    },
    {
      name: 'copy',
      description: t('local.copy'),
      argumentHint: '[code|<lang>|latex|inline-latex] [index]',
    },
    { name: 'delete', description: t('local.delete') },
    { name: 'release', description: t('local.release') },
    { name: 'auth', description: t('local.auth') },
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
    {
      name: 'mcp',
      description: t('local.mcp'),
      argumentHint: 'desc|nodesc|schema|auth|noauth',
    },
    { name: 'skills', description: t('local.skills') },
    { name: 'status', description: t('local.status') },
    {
      name: 'stats',
      description: t('local.stats'),
      argumentHint: '[model|tools]',
      subcommands: ['model', 'tools'],
    },
    { name: 'tools', description: t('local.tools'), argumentHint: '[desc]' },
    {
      name: 'memory',
      description: t('local.memory'),
    },
    {
      name: 'context',
      description: t('local.context'),
      argumentHint: '[detail]',
    },
    {
      name: 'agents',
      description: t('local.agents'),
      argumentHint: 'manage|create',
    },
    {
      name: 'goal',
      description: t('local.goal'),
      argumentHint: '[<condition> | clear]',
    },
    { name: 'tasks', description: t('local.tasks') },
    { name: 'recap', description: t('local.recap') },
    {
      name: 'branch',
      description: t('local.branch'),
      argumentHint: '[<name>]',
    },
    {
      name: 'fork',
      description: t('local.fork'),
      argumentHint: '<directive>',
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
    { name: 'settings', description: t('local.settings') },
    {
      name: 'extensions',
      description: t('local.extensions'),
      argumentHint: 'manage|install <source>',
      subcommands: ['manage', 'install'],
    },
  ];
  return commands.map((command) => ({
    ...command,
    source: 'builtin-command',
  }));
}
