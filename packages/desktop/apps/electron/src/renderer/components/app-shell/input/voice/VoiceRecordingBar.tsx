import React from 'react';

/** Full-width recording strip: dotted leader → live waveform → elapsed timer. */
export interface VoiceRecordingBarProps {
  levels: number[];
  elapsedMs: number;
  /** Live interim transcript (realtime models); floated above the bar. */
  interimText?: string;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function VoiceRecordingBar({
  levels,
  elapsedMs,
  interimText,
}: VoiceRecordingBarProps): React.JSX.Element {
  return (
    <div className="relative flex-1 flex items-center gap-2 min-w-0 px-1">
      {interimText && (
        <span className="absolute bottom-full left-1 mb-1 max-w-[70%] truncate rounded-md bg-popover px-2 py-1 text-xs text-muted-foreground shadow-md ring-1 ring-border">
          {interimText}
        </span>
      )}
      <span className="flex-1 border-t border-dotted border-foreground/30" />
      <span className="flex items-center gap-px h-4 shrink-0" aria-hidden="true">
        {levels.map((lvl, i) => (
          <span
            key={i}
            className="w-0.5 rounded-full bg-foreground/80"
            style={{ height: `${2 + Math.round(lvl * 14)}px` }}
          />
        ))}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground shrink-0">
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}
