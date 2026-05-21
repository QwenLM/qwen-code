interface Shortcut {
  key: string;
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { key: '!', description: 'for shell mode' },
  { key: '/', description: 'for commands' },
  { key: '@', description: 'for file paths' },
  { key: 'shift+tab', description: 'to cycle approvals' },
  { key: 'esc', description: 'to cancel request' },
  { key: 'shift+enter', description: 'for newline' },
  { key: 'ctrl+r', description: 'to search history' },
  { key: '↑ / ↓', description: 'to navigate history' },
  { key: 'cmd+v', description: 'to paste images' },
  { key: '?', description: 'to toggle this panel' },
];

export function ShortcutsPanel() {
  const mid = Math.ceil(SHORTCUTS.length / 2);
  const col1 = SHORTCUTS.slice(0, mid);
  const col2 = SHORTCUTS.slice(mid);

  return (
    <div className="shortcuts-panel">
      <div className="shortcuts-column">
        {col1.map((s) => (
          <div key={s.key} className="shortcuts-item">
            <span className="shortcuts-key">{s.key}</span>
            <span className="shortcuts-desc">{s.description}</span>
          </div>
        ))}
      </div>
      <div className="shortcuts-column">
        {col2.map((s) => (
          <div key={s.key} className="shortcuts-item">
            <span className="shortcuts-key">{s.key}</span>
            <span className="shortcuts-desc">{s.description}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
