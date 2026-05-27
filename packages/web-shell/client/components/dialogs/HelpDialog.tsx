import { useEffect, useMemo, useRef, useState } from 'react';
import { dp } from './dialogStyles';
import type { CommandInfo } from '../../adapters/types';
import { useDelayedGlobalKeyDown } from '../../hooks/useDelayedGlobalKeyDown';
import { useI18n } from '../../i18n';
import styles from './HelpDialog.module.css';

type HelpTab = 'general' | 'commands' | 'custom-commands';

interface HelpDialogProps {
  commands: readonly CommandInfo[];
  onClose: () => void;
}

interface CommandGroup {
  key: string;
  title: string;
  commands: CommandInfo[];
}

const TABS: Array<{ id: HelpTab; labelKey: string }> = [
  { id: 'general', labelKey: 'help.tab.general' },
  { id: 'commands', labelKey: 'help.tab.commands' },
  { id: 'custom-commands', labelKey: 'help.tab.custom' },
];

const DOCS_URL = 'https://qwenlm.github.io/qwen-code-docs/';
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
  'mode',
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
  ['Ctrl+L', 'help.shortcut.clear'],
  ['Shift+Enter', 'help.shortcut.newline'],
  ['Shift+Tab', 'help.shortcut.approvals'],
  ['Alt+Left/Right', 'help.shortcut.altWords'],
  ['Up/Down', 'help.shortcut.history'],
];

function commandSignature(command: CommandInfo): string {
  return [`/${command.name}`, command.argumentHint].filter(Boolean).join(' ');
}

function commandMeta(
  command: CommandInfo,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const parts = [
    BUILT_IN_COMMANDS.has(command.name)
      ? t('help.commandMeta.builtIn')
      : t('help.commandMeta.custom'),
    command.subcommands?.length
      ? t('help.commandMeta.subcommands', {
          count: command.subcommands.length,
        })
      : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

function groupCommands(
  commands: readonly CommandInfo[],
  customOnly: boolean,
  t: ReturnType<typeof useI18n>['t'],
): CommandGroup[] {
  const visible = commands
    .filter((command) => command.name && command.description !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  const builtIn = visible.filter((command) =>
    BUILT_IN_COMMANDS.has(command.name),
  );
  const custom = visible.filter(
    (command) => !BUILT_IN_COMMANDS.has(command.name),
  );

  if (customOnly) {
    return custom.length
      ? [
          {
            key: 'custom',
            title: t('help.customGroup'),
            commands: custom,
          },
        ]
      : [];
  }

  return builtIn.length
    ? [{ key: 'built-in', title: t('help.builtIn'), commands: builtIn }]
    : [];
}

function HelpTabs({ activeTab }: { activeTab: HelpTab }) {
  const { t } = useI18n();
  return (
    <div className={styles.tabs}>
      <span className={styles.brand}>Qwen Code</span>
      {TABS.map((tab) => (
        <span
          key={tab.id}
          className={`${styles.tab} ${
            tab.id === activeTab ? styles.tabActive : ''
          }`}
        >
          {t(tab.labelKey)}
        </span>
      ))}
    </div>
  );
}

function GeneralHelp() {
  const { t } = useI18n();
  return (
    <div className={styles.general}>
      <div className={styles.intro}>{t('help.intro')}</div>
      <div className={styles.sectionTitle}>{t('help.section.shortcuts')}</div>
      <div className={styles.shortcuts}>
        {GENERAL_SHORTCUTS.map(([key, description]) => (
          <div className={styles.shortcut} key={key}>
            <span className={styles.shortcutKey}>{key}</span>
            <span className={styles.shortcutDesc}>{t(description)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandsHelp({
  commands,
  customOnly,
}: {
  commands: readonly CommandInfo[];
  customOnly: boolean;
}) {
  const { t } = useI18n();
  const groups = useMemo(
    () => groupCommands(commands, customOnly, t),
    [commands, customOnly, t],
  );
  const listRef = useRef<HTMLDivElement>(null);

  useDelayedGlobalKeyDown((event: KeyboardEvent) => {
    const el = listRef.current;
    if (!el) return;
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      el.scrollBy({ top: 32, behavior: 'smooth' });
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      el.scrollBy({ top: -32, behavior: 'smooth' });
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      el.scrollBy({ top: el.clientHeight, behavior: 'smooth' });
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      el.scrollBy({ top: -el.clientHeight, behavior: 'smooth' });
    } else if (event.key === 'Home') {
      event.preventDefault();
      el.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (event.key === 'End') {
      event.preventDefault();
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [customOnly, commands]);

  if (groups.length === 0) {
    return (
      <div className={styles.empty}>
        {customOnly ? t('help.emptyCustom') : t('help.empty')}
      </div>
    );
  }

  return (
    <div className={styles.commandList} ref={listRef}>
      <div className={styles.commandListIntro}>
        {customOnly ? t('help.customIntro') : t('help.commandsIntro')}
      </div>
      {groups.map((group) => (
        <div className={styles.commandGroup} key={group.key}>
          <div className={styles.commandGroupTitle}>
            {group.title}
            <span>{group.commands.length}</span>
          </div>
          {group.commands.map((command) => (
            <div className={styles.command} key={command.name}>
              <div className={styles.commandRow}>
                <span className={styles.commandName}>
                  {commandSignature(command)}
                </span>
                <span className={styles.commandMeta}>
                  {commandMeta(command, t)}
                </span>
              </div>
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
          ))}
        </div>
      ))}
    </div>
  );
}

export function HelpDialog({ commands, onClose }: HelpDialogProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<HelpTab>('general');

  useDelayedGlobalKeyDown(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const current = TABS.findIndex((tab) => tab.id === activeTab);
        const direction = event.shiftKey ? -1 : 1;
        const next = (current + direction + TABS.length) % TABS.length;
        setActiveTab(TABS[next].id);
      }
    },
    [activeTab, onClose],
  );

  return (
    <div className={`${dp('resume-picker')} ${styles.dialog}`}>
      <div className={dp('resume-picker-header')}>
        <span className={dp('resume-picker-title')}>{t('help.title')}</span>
        <span className={dp('resume-picker-count')}>
          {t('help.commandCount', { count: commands.length })}
        </span>
      </div>
      <div className={dp('resume-picker-sep')} />
      <div className={styles.body}>
        <HelpTabs activeTab={activeTab} />
        {activeTab === 'general' && <GeneralHelp />}
        {activeTab === 'commands' && (
          <CommandsHelp commands={commands} customOnly={false} />
        )}
        {activeTab === 'custom-commands' && (
          <CommandsHelp commands={commands} customOnly />
        )}
      </div>
      <div className={dp('resume-picker-sep')} />
      <div className={dp('resume-picker-footer')}>
        {t('help.footer')} · {DOCS_URL}
      </div>
    </div>
  );
}
