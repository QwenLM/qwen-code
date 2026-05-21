interface StatusBarProps {
  connected: boolean;
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking';
  currentModel: string;
  currentMode: string;
  tokenCount: number;
  contextWindow: number;
}

function getModeIndicator(
  mode: string,
): { label: string; className: string } | null {
  switch (mode) {
    case 'plan':
      return { label: 'plan mode', className: 'status-mode-plan' };
    case 'auto-edit':
      return { label: 'auto-accept edits', className: 'status-mode-auto-edit' };
    case 'yolo':
      return { label: 'YOLO mode', className: 'status-mode-yolo' };
    default:
      return null;
  }
}

export function StatusBar({
  connected,
  currentModel,
  currentMode,
  tokenCount,
  contextWindow,
}: StatusBarProps) {
  const pct = contextWindow > 0 ? (tokenCount / contextWindow) * 100 : 0;
  const pctDisplay = pct.toFixed(1);
  const modeIndicator = getModeIndicator(currentMode);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {modeIndicator ? (
          <>
            <span className={`status-mode-label ${modeIndicator.className}`}>
              {modeIndicator.label}
            </span>
            <span className="status-mode-hint">(shift + tab to cycle)</span>
          </>
        ) : (
          <span className="status-hint">? for shortcuts</span>
        )}
      </div>

      <div className="status-bar-right">
        {!connected && <span className="status-disconnected">断开连接</span>}
        {currentModel && <span className="status-model">{currentModel}</span>}
        {contextWindow > 0 && tokenCount > 0 && (
          <span className="status-context">{pctDisplay}% 上下文已用</span>
        )}
      </div>
    </div>
  );
}
