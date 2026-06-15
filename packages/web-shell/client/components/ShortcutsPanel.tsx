import { useEffect, useRef } from 'react';
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
    ? 'shift+enter / ctrl+j / opt+enter / cmd+enter'
    : 'shift+enter / ctrl+j / alt+enter / ctrl+enter';
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
  { key: 'ctrl+r', descriptionKey: 'help.shortcut.searchHistory' },
  { key: '↑ / ↓', descriptionKey: 'help.shortcut.history' },
  { key: '?', descriptionKey: 'help.shortcut.togglePanel' },
];

interface ShortcutsPanelProps {
  onClose?: () => void;
}

export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Dismiss like the other inline panels (Settings/Mode pickers): Escape, or a
  // primary-button / touch press outside the panel. Listeners attach after
  // mount, so the press that opened the panel cannot immediately close it.
  useEffect(() => {
    const onPointerOutside = (event: Event) => {
      // Only the primary (left) button dismisses; middle-click pastes and
      // right-click opens a context menu. Touch events have no button.
      if (event instanceof MouseEvent && event.button !== 0) return;
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      if (panel && target instanceof Node && !panel.contains(target)) {
        onCloseRef.current?.();
      }
    };
    // Escape must win over the App-level global Escape handler, which is a
    // bubble listener registered earlier and not gated on the panel — it would
    // otherwise clear queued prompts / cancel the stream / arm "Esc to clear"
    // first, leaving the panel open. Capture runs before it, and
    // stopPropagation keeps it from firing.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
      }
    };
    window.addEventListener('mousedown', onPointerOutside);
    window.addEventListener('touchstart', onPointerOutside);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onPointerOutside);
      window.removeEventListener('touchstart', onPointerOutside);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

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
    <div ref={panelRef} className={styles.panel}>
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
