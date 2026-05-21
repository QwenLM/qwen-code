import { useState, useEffect, useRef } from 'react';
import {
  PHRASE_CHANGE_INTERVAL_MS,
  getLoadingPhrases,
} from '../constants/loadingPhrases';

interface StreamingStatusProps {
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking';
  tokenCount: number;
}

export function StreamingStatus({
  streamingState,
  tokenCount,
}: StreamingStatusProps) {
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const [dotFrame, setDotFrame] = useState(0);
  const [loadingPhrase, setLoadingPhrase] = useState(() => {
    const phrases = getLoadingPhrases();
    return phrases[0] ?? '';
  });

  useEffect(() => {
    startTime.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [streamingState]);

  useEffect(() => {
    const phrases = getLoadingPhrases();
    if (streamingState === 'idle' || phrases.length === 0) {
      setLoadingPhrase(phrases[0] ?? '');
      return;
    }

    const pickPhrase = () => {
      const idx = Math.floor(Math.random() * phrases.length);
      setLoadingPhrase(phrases[idx] ?? '');
    };

    pickPhrase();
    const interval = setInterval(pickPhrase, PHRASE_CHANGE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamingState]);

  useEffect(() => {
    if (streamingState === 'idle') return;
    const interval = setInterval(() => {
      setDotFrame((f) => (f + 1) % 4);
    }, 250);
    return () => clearInterval(interval);
  }, [streamingState]);

  if (streamingState === 'idle') return null;

  const dots = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinnerChar = dots[dotFrame % dots.length];
  const arrow = streamingState === 'responding' ? '↓' : '↑';
  const tokenStr = tokenCount > 0 ? ` · ${arrow} ${tokenCount} tokens` : '';

  return (
    <div className="streaming-status">
      <span className="streaming-status-spinner">{spinnerChar}</span>
      {loadingPhrase && (
        <span className="streaming-status-label">{loadingPhrase}</span>
      )}
      <span className="streaming-status-meta">
        ({elapsed}s{tokenStr} · esc to cancel)
      </span>
    </div>
  );
}
