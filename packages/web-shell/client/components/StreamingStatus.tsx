import { useState, useEffect, useRef } from 'react';
import {
  PHRASE_CHANGE_INTERVAL_MS,
  getLoadingPhrases,
} from '../constants/loadingPhrases';
import { useI18n } from '../i18n';
import styles from './StreamingStatus.module.css';

interface StreamingStatusProps {
  streamingState: 'idle' | 'waiting' | 'responding' | 'thinking';
  tokenCount: number;
}

export function StreamingStatus({
  streamingState,
  tokenCount,
}: StreamingStatusProps) {
  const { language, t } = useI18n();
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const [dotFrame, setDotFrame] = useState(0);
  const [loadingPhrase, setLoadingPhrase] = useState(() => {
    const phrases = getLoadingPhrases(language);
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
  const arrow = streamingState === 'responding' ? '↓' : '↑';
  const tokenStr =
    tokenCount > 0
      ? ` · ${arrow} ${t('stream.tokens', { count: tokenCount })}`
      : '';

  return (
    <div className={styles.status}>
      <span className={styles.spinner}>{spinnerChar}</span>
      {loadingPhrase && <span className={styles.label}>{loadingPhrase}</span>}
      <span className={styles.meta}>
        ({elapsed}s{tokenStr} · {t('stream.cancel')})
      </span>
    </div>
  );
}
