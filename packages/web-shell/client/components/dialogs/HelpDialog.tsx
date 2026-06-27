import { useMemo, useState } from 'react';
import type { CommandInfo } from '../../adapters/types';
import { useI18n } from '../../i18n';
import styles from './HelpDialog.module.css';

type HelpTab = 'general' | 'commands' | 'custom-commands';

interface HelpDialogProps {
  commands: readonly CommandInfo[];
}

const TABS: Array<{ id: HelpTab; labelKey: string }> = [
  { id: 'general', labelKey: 'help.tab.general' },
  { id: 'commands', labelKey: 'help.tab.commands' },
  { id: 'custom-commands', labelKey: 'help.tab.custom' },
];

const BUILT_IN_COMMANDS = new Set([
  'about',
  'agents',
  'approval-mode',
  'arena',
  'auth',
  'branch',
  'btw',
  'bug',
  'clear',
  'compress',
  'context',
  'copy',
  'release',
  'diff',
  'directory',
  'docs',
  'doctor',
  'dream',
  'editor',
  'export',
  'extensions',
  'forget',
  'goal',
  'help',
  'hooks',
  'ide',
  'init',
  'insight',
  'language',
  'lsp',
  'mcp',
  'memory',
  'model',
  'new',
  'permissions',
  'plan',
  'quit',
  'recap',
  'remember',
  'rename',
  'reset',
  'restore',
  'resume',
  'rewind',
  'settings',
  'setup-github',
  'skills',
  'stats',
  'status',
  'statusline',
  'summary',
  'tasks',
  'terminal-setup',
  'theme',
  'tools',
  'trust',
  'vim',
]);

const GENERAL_SHORTCUTS: Array<[string, string]> = [
  ['@', 'help.shortcut.addContext'],
  ['!', 'help.shortcut.shell'],
  ['/', 'help.shortcut.commandMenu'],
  ['Tab', 'help.shortcut.completion'],
  ['Esc', 'help.shortcut.cancel'],
  ['Ctrl+J', 'help.shortcut.newline'],
  ['Ctrl+L', 'help.shortcut.clear'],
  ['Ctrl+Y', 'help.shortcut.retry'],
  ['Shift+Tab', 'help.shortcut.approvals'],
  ['Alt+Left/Right', 'help.shortcut.altWords'],
  ['Up/Down', 'help.shortcut.history'],
];

function commandSignature(command: CommandInfo): string {
  return [`/${command.name}`, command.argumentHint].filter(Boolean).join(' ');
}

function isCustomCommand(command: CommandInfo): boolean {
  return !BUILT_IN_COMMANDS.has(command.name);
}

function commandMeta(
  command: CommandInfo,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return isCustomCommand(command)
    ? t('help.commandMeta.custom')
    : t('help.commandMeta.builtIn');
}

function filterCommands(
  commands: readonly CommandInfo[],
  tab: HelpTab,
  query: string,
): CommandInfo[] {
  const normalized = query.trim().toLowerCase();
  return commands
    .filter((command) => command.name && command.description !== undefined)
    .filter((command) => {
      if (tab === 'commands') return !isCustomCommand(command);
      if (tab === 'custom-commands') return isCustomCommand(command);
      return true;
    })
    .filter((command) => {
      if (!normalized) return true;
      return (
        command.name.toLowerCase().includes(normalized) ||
        (command.description ?? '').toLowerCase().includes(normalized) ||
        (command.argumentHint ?? '').toLowerCase().includes(normalized)
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function GeneralHelp() {
  const { t } = useI18n();
  return (
    <div className={styles.general}>
      <div className={styles.shortcuts}>
        {GENERAL_SHORTCUTS.map(([key, description]) => (
          <div className={styles.shortcut} key={key}>
            <span className={styles.shortcutDesc}>{t(description)}</span>
            <span className={styles.shortcutKey}>{key}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandsHelp({
  commands,
  tab,
  query,
}: {
  commands: readonly CommandInfo[];
  tab: HelpTab;
  query: string;
}) {
  const { t } = useI18n();
  const [expandedCommand, setExpandedCommand] = useState<string | null>(null);
  const visibleCommands = useMemo(
    () => filterCommands(commands, tab, query),
    [commands, query, tab],
  );

  if (visibleCommands.length === 0) {
    return (
      <div className={styles.empty}>
        {tab === 'custom-commands' ? t('help.emptyCustom') : t('help.empty')}
      </div>
    );
  }

  return (
    <div className={styles.commandList}>
      {visibleCommands.map((command) => {
        const expanded = expandedCommand === command.name;
        return (
          <article
            className={`${styles.commandCard} ${
              expanded ? styles.commandCardExpanded : ''
            }`}
            key={command.name}
          >
            <button
              type="button"
              className={styles.commandRow}
              onClick={() => setExpandedCommand(expanded ? null : command.name)}
              aria-expanded={expanded}
            >
              <span className={styles.commandName}>
                {commandSignature(command)}
              </span>
              <span className={styles.commandTag}>
                {commandMeta(command, t)}
              </span>
              <svg
                className={`${styles.chevron} ${
                  expanded ? styles.chevronExpanded : ''
                }`}
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M6 4.5 9.5 8 6 11.5"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {expanded && (
              <div className={styles.commandDetail}>
                {command.description && (
                  <div className={styles.commandDescription}>
                    {command.description}
                  </div>
                )}
                {!!command.subcommands?.length && (
                  <div className={styles.commandSubcommands}>
                    {t('help.subcommands')}: {command.subcommands.join(', ')}
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function HelpDialog({ commands }: HelpDialogProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<HelpTab>('general');
  const [query, setQuery] = useState('');
  const showSearch = activeTab !== 'general';

  return (
    <div className={styles.dialog}>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`${styles.tab} ${
                tab.id === activeTab ? styles.tabActive : ''
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        {showSearch && (
          <input
            className={styles.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('help.search')}
          />
        )}
      </div>

      {activeTab === 'general' ? (
        <GeneralHelp />
      ) : (
        <CommandsHelp commands={commands} tab={activeTab} query={query} />
      )}
    </div>
  );
}
