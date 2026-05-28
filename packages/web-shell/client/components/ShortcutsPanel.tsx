import { useI18n } from '../i18n';
import styles from './ShortcutsPanel.module.css';

interface Shortcut {
  key: string;
  descriptionKey: string;
}

const SHORTCUTS: Shortcut[] = [
  { key: '/', descriptionKey: 'help.shortcut.commandMenu' },
  { key: '@', descriptionKey: 'help.shortcut.addContext' },
  { key: 'shift+tab', descriptionKey: 'help.shortcut.approvals' },
  { key: 'esc', descriptionKey: 'help.shortcut.cancel' },
  { key: 'ctrl+j', descriptionKey: 'help.shortcut.newline' },
  { key: 'ctrl+l', descriptionKey: 'help.shortcut.clear' },
  { key: 'ctrl+y', descriptionKey: 'help.shortcut.retry' },
  { key: 'ctrl+o', descriptionKey: 'help.shortcut.compact' },
  { key: 'ctrl+r', descriptionKey: 'help.shortcut.history' },
  { key: '↑ / ↓', descriptionKey: 'help.shortcut.history' },
  { key: 'cmd+v', descriptionKey: 'help.shortcut.pasteImages' },
  { key: '?', descriptionKey: 'help.shortcut.togglePanel' },
];

export function ShortcutsPanel() {
  const { t } = useI18n();
  const mid = Math.ceil(SHORTCUTS.length / 2);
  const col1 = SHORTCUTS.slice(0, mid);
  const col2 = SHORTCUTS.slice(mid);

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
