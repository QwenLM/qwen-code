import { useCallback, useState, useEffect, useRef } from 'react';
import {
  PHRASE_CHANGE_INTERVAL_MS,
  getLoadingPhrases,
} from '../constants/loadingPhrases';
import { useStreamingState } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../i18n';
import { useWebShellCustomization } from '../customization';
import { useStreamingLoadingMetrics } from '../hooks/useStreamingLoadingMetrics';
import { formatTokenCount } from '../utils/formatTokenCount';
import styles from './StreamingStatus.module.css';

interface StreamingStatusProps {
  startedAt?: number;
}

export function StreamingStatus({ startedAt }: StreamingStatusProps) {
  const streamingState = useStreamingState();
  const { estimatedOutputTokens, isReceivingContent } =
    useStreamingLoadingMetrics();
  const { language, t } = useI18n();
  const { loadingPhrases: customLoadingPhrases } = useWebShellCustomization();
  // Read the resolver through a ref so its identity never feeds the rotation
  // effect below. A host that passes an inline `loadingPhrases` arrow hands a
  // fresh reference on every render, and during streaming App re-renders on
  // every transcript delta — so depending on the resolver identity would tear
  // down and recreate the 15s interval each render and flicker the phrase. The
  // ref keeps the latest resolver while `resolvePhrases` stays stable; a changed
  // resolver's output is picked up on the next tick.
  const customLoadingPhrasesRef = useRef(customLoadingPhrases);
  customLoadingPhrasesRef.current = customLoadingPhrases;
  // Prefer the host's custom phrases; fall back to the built-in defaults when
  // the resolver is absent or returns undefined/null. An empty array is honored
  // as an explicit "hide" signal.
  const resolvePhrases = useCallback(
    (lang: string): readonly string[] =>
      customLoadingPhrasesRef.current?.(lang) ?? getLoadingPhrases(lang),
    [],
  );
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const [dotFrame, setDotFrame] = useState(0);
  const [loadingPhrase, setLoadingPhrase] = useState(
    () => resolvePhrases(language)[0] ?? '',
  );

  const isActive = streamingState !== 'idle';

  useEffect(() => {
    if (!isActive) {
      setElapsed(0);
      return;
    }

    startTime.current = startedAt ?? Date.now();
    setElapsed(elapsedSeconds(startTime.current));
    const interval = setInterval(() => {
      setElapsed(elapsedSeconds(startTime.current));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive, startedAt]);

  useEffect(() => {
    if (streamingState === 'idle') {
      setLoadingPhrase(resolvePhrases(language)[0] ?? '');
      return;
    }

    // Re-resolve on every tick (not once at effect setup) so a host that swaps
    // its resolver mid-stream is reflected on the next tick — resolvePhrases is
    // kept stable by the ref above, so the effect itself does not re-run on
    // resolver identity changes. An empty result picks index 0 → '' and hides
    // the phrase, and is re-checked on the following tick.
    const pickPhrase = () => {
      const phrases = resolvePhrases(language);
      const idx = Math.floor(Math.random() * phrases.length);
      setLoadingPhrase(phrases[idx] ?? '');
    };

    pickPhrase();
    const interval = setInterval(pickPhrase, PHRASE_CHANGE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [language, streamingState, resolvePhrases]);

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

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.ceil((Date.now() - startedAt) / 1000));
}
