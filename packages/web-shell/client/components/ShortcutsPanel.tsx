import { useI18n } from '../i18n';
import styles from './ShortcutsPanel.module.css';

interface Shortcut {
  key: string;
  descriptionKey: string;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData;
  const platform = userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function getPasteImagesShortcut(): string {
  return isMacPlatform() ? 'cmd+v' : 'ctrl+v';
}

function getNewlineShortcut(): string {
  // Alt+Enter is labeled Option (⌥) on macOS; Mod+Enter resolves to
  // Cmd+Enter on macOS and Ctrl+Enter elsewhere.
  return isMacPlatform()
    ? 'shift+enter / ctrl+j / opt+enter'
    : 'shift+enter / ctrl+j / alt+enter';
}

const SHORTCUTS: Shortcut[] = [
  { key: '/', descriptionKey: 'help.shortcut.commandMenu' },
  { key: '@', descriptionKey: 'help.shortcut.addContext' },
  { key: 'shift+tab', descriptionKey: 'help.shortcut.approvals' },
  { key: 'esc', descriptionKey: 'help.shortcut.cancel' },
  { key: getNewlineShortcut(), descriptionKey: 'help.shortcut.newline' },
  { key: 'ctrl+l', descriptionKey: 'help.shortcut.clear' },
  { key: 'ctrl+y', descriptionKey: 'help.shortcut.retry' },
  { key: 'ctrl+o', descriptionKey: 'help.shortcut.compact' },
  { key: 'ctrl+r', descriptionKey: 'help.shortcut.history' },
  { key: '↑ / ↓', descriptionKey: 'help.shortcut.history' },
  { key: '?', descriptionKey: 'help.shortcut.togglePanel' },
];

export function ShortcutsPanel() {
  const { t } = useI18n();
  const shortcuts = [
    ...SHORTCUTS.slice(0, -1),
    {
      key: getPasteImagesShortcut(),
      descriptionKey: 'help.shortcut.pasteImages',
    },
    SHORTCUTS[SHORTCUTS.length - 1],
  ];
  const mid = Math.ceil(shortcuts.length / 2);
  const col1 = shortcuts.slice(0, mid);
  const col2 = shortcuts.slice(mid);

  return (
    <div className={styles.panel}>
      <div className={styles.column}>
        {col1.map((s) => (
          <div key={s.key} className={styles.item}>
            <span className={styles.key}>{s.key}</span>
            <span className={styles.desc}>{t(s.descriptionKey)}</span>
          </div>
        ))}
      </div>
      <div className={styles.column}>
        {col2.map((s) => (
          <div key={s.key} className={styles.item}>
            <span className={styles.key}>{s.key}</span>
            <span className={styles.desc}>{t(s.descriptionKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
