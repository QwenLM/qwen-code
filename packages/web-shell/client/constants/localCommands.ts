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
      argumentHint: '[--fast|--voice|--vision] [<model>]',
    },
    {
      name: 'mcp',
      description: t('local.mcp'),
      argumentHint: 'desc|nodesc|schema',
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
    { name: 'rewind', description: t('local.rewind') },
    {
      name: 'branch',
      description: t('local.branch'),
      argumentHint: '[<name>]',
    },
    { name: 'diff', description: t('local.diff') },
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
    { name: 'schedule', description: t('local.schedule') },
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

/**
 * Built-in commands the daemon advertises but that are NOT part of
 * getLocalCommands (they are feature/extension-gated, so we must not pin them
 * into the always-on fallback list). The daemon fills their descriptions in the
 * daemon *process* language, which is independent of the web-shell UI language,
 * so without this the slash menu ends up a mix of languages. We re-localize
 * these built-ins by name to the current UI language.
 *
 * Maps command name -> i18n key. Guarded by source === 'builtin-command', so a
 * user's custom command that happens to share a built-in name keeps its own
 * description.
 */
const BUILTIN_COMMAND_DESCRIPTION_KEYS: Record<string, string> = {
  bug: 'local.bug',
  compress: 'local.compress',
  'compress-fast': 'local.compressFast',
  config: 'local.config',
  diff: 'local.diff',
  directory: 'local.directory',
  docs: 'local.docs',
  doctor: 'local.doctor',
  dream: 'local.dream',
  effort: 'local.effort',
  export: 'local.export',
  forget: 'local.forget',
  hooks: 'local.hooks',
  'import-config': 'local.importConfig',
  init: 'local.init',
  insight: 'local.insight',
  lsp: 'local.lsp',
  remember: 'local.remember',
  summary: 'local.summary',
  workflows: 'local.workflows',
};

/**
 * Skills whose author-written descriptions ship in English — the Qwen Code
 * bundled skills plus this repo's `.qwen/skills` project skills. We re-localize
 * their menu descriptions by name so a zh-CN slash menu isn't a mix of languages.
 * Keyed by skill name because a skill only carries a reliable `source` once a
 * session exists; the skill-tagging step keys off `connection.skills` instead, so
 * this works on the welcome screen too. Display-only — the model still receives
 * the daemon's canonical (English) description. Skills not listed here (a user's
 * own skills, newly added ones) fall back to their authored description.
 */
const SKILL_DESCRIPTION_KEYS: Record<string, string> = {
  // Bundled with Qwen Code (packages/core/src/skills/bundled).
  batch: 'skilldesc.batch',
  dataviz: 'skilldesc.dataviz',
  'extension-creator': 'skilldesc.extensionCreator',
  loop: 'skilldesc.loop',
  'new-app': 'skilldesc.newApp',
  'qc-helper': 'skilldesc.qcHelper',
  review: 'skilldesc.review',
  simplify: 'skilldesc.simplify',
  stuck: 'skilldesc.stuck',
  // This repo's project skills (.qwen/skills).
  'agent-reproduce-align': 'skilldesc.agentReproduceAlign',
  'agent-reproduce-feature': 'skilldesc.agentReproduceFeature',
  autofix: 'skilldesc.autofix',
  bugfix: 'skilldesc.bugfix',
  codegraph: 'skilldesc.codegraph',
  'create-issue': 'skilldesc.createIssue',
  'desktop-pet': 'skilldesc.desktopPet',
  'docs-audit-and-refresh': 'skilldesc.docsAuditAndRefresh',
  'docs-update-from-diff': 'skilldesc.docsUpdateFromDiff',
  'e2e-testing': 'skilldesc.e2eTesting',
  'feat-dev': 'skilldesc.featDev',
  'memory-leak-debug': 'skilldesc.memoryLeakDebug',
  'openwork-desktop-sync': 'skilldesc.openworkDesktopSync',
  'prepare-pr': 'skilldesc.preparePr',
  'qwen-code-claw': 'skilldesc.qwenCodeClaw',
  'structured-debugging': 'skilldesc.structuredDebugging',
  'terminal-capture': 'skilldesc.terminalCapture',
  'tmux-real-user-testing': 'skilldesc.tmuxRealUserTesting',
  triage: 'skilldesc.triage',
};

/**
 * i18n key for a known skill's localized menu description, or undefined for a
 * skill we don't ship a translation for (leave its authored description).
 */
export function skillDescriptionKey(name: string): string | undefined {
  return SKILL_DESCRIPTION_KEYS[name];
}

/**
 * Re-localize built-in command descriptions by name so the slash menu matches
 * the web-shell UI language even when the daemon advertises them in its own
 * process language. Translates when source is explicitly 'builtin-command' or
 * when no source is set (daemon may omit _meta.source in some event paths).
 * Commands with a non-builtin source (e.g. 'skill', 'custom') are left alone.
 * (Skills are localized separately in the skill-tagging step.)
 */
export function localizeBuiltinDescriptions(
  commands: CommandInfo[],
  t: Translate,
): CommandInfo[] {
  return commands.map((command) => {
    const key = BUILTIN_COMMAND_DESCRIPTION_KEYS[command.name];
    if (!key) return command;
    if (command.source && command.source !== 'builtin-command') return command;
    return { ...command, description: t(key) };
  });
}
