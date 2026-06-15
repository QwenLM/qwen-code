import { useState, useEffect, useRef } from 'react';
import {
  PHRASE_CHANGE_INTERVAL_MS,
  getLoadingPhrases,
} from '../constants/loadingPhrases';
import { useStreamingState } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import { useStreamingLoadingMetrics } from '../hooks/useStreamingLoadingMetrics';
import { formatTokenCount } from '../utils/formatTokenCount';
import styles from './StreamingStatus.module.css';

export function StreamingStatus() {
  const streamingState = useStreamingState();
  const { estimatedOutputTokens, isReceivingContent } =
    useStreamingLoadingMetrics();
  const { language, t } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const [dotFrame, setDotFrame] = useState(0);
  const [loadingPhrase, setLoadingPhrase] = useState(() => {
    const phrases = getLoadingPhrases(language);
    return phrases[0] ?? '';
  });

  const isActive = streamingState !== 'idle';

  useEffect(() => {
    if (!isActive) {
      setElapsed(0);
      return;
    }

    startTime.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    const phrases = getLoadingPhrases(language);
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
  }, [language, streamingState]);

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
  const arrow = isReceivingContent ? '↓' : '↑';
  const timeStr = elapsed < 60 ? `${elapsed}s` : formatDuration(elapsed * 1000);
  const tokenStr =
    estimatedOutputTokens > 0
      ? ` · ${arrow} ${t('stream.tokens', { count: formatTokenCount(estimatedOutputTokens) })}`
      : '';

  return (
    <div className={styles.status}>
      <span className={styles.spinner}>{spinnerChar}</span>
      {loadingPhrase && <span className={styles.label}>{loadingPhrase}</span>}
      <span className={styles.meta}>
        ({timeStr}
        {tokenStr} · {t('stream.cancel')})
      </span>
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '0s';

  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.length > 0 ? parts.join(' ') : '0s';
}
