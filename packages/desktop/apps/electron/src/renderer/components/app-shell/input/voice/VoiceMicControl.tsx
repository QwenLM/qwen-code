import React from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { UseVoiceDictationReturn } from './useVoiceDictation';

/**
 * The circular voice control in the composer toolbar: an idle mic that starts
 * dictation, or — while recording/connecting — a stop button (square in a soft
 * circle, like the reference). Transcribing shows a spinner.
 */
export interface VoiceMicControlProps {
  voice: UseVoiceDictationReturn;
  /** Composer disabled (mid-turn) — blocks starting, not stopping. */
  disabled?: boolean;
}

export function VoiceMicControl({
  voice,
  disabled,
}: VoiceMicControlProps): React.JSX.Element {
  const { isRecording, isConnecting, isTranscribing, isError } = voice;

  if (isTranscribing) {
    return (
      <span
        role="status"
        aria-label="Transcribing…"
        className="flex items-center justify-center h-7 w-7 rounded-full shrink-0 ml-1 text-muted-foreground"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    );
  }

  if (isRecording || isConnecting) {
    const label = isConnecting ? 'Cancel' : 'Stop dictation';
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => (isConnecting ? voice.abort() : voice.stop())}
        className="flex items-center justify-center h-7 w-7 rounded-full shrink-0 ml-1 bg-foreground/10 hover:bg-foreground/15 active:bg-foreground/20 transition-colors"
      >
        {isConnecting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Square className="h-3 w-3 fill-current" />
        )}
      </button>
    );
  }

  const label = isError
    ? `Voice error — click to retry${voice.errorMessage ? `: ${voice.errorMessage}` : ''}`
    : voice.notice
      ? 'No speech detected — click to retry'
      : 'Start voice dictation';
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={label}
          className={cn(
            'h-7 w-7 rounded-full shrink-0 ml-1',
            isError && 'text-red-500 hover:text-red-500',
          )}
          disabled={Boolean(disabled)}
          onClick={() => voice.start()}
        >
          <Mic className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {voice.errorMessage ?? voice.notice ?? label}
      </TooltipContent>
    </Tooltip>
  );
}
