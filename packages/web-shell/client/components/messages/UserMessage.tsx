import { memo, useEffect, useRef, useState } from 'react';
import { PromptChevron } from '../PromptChevron';
import { isSafeImageSrc } from './Markdown';
import { useI18n } from '../../i18n';
import type { TurnCollapseHead } from '../../adapters/types';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
  /** When set, renders a toggle that folds/unfolds this turn's steps. */
  collapse?: TurnCollapseHead;
  onToggleCollapse?: (turnId: string) => void;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** Compact turn duration: `820ms` · `12.4s` · `1m 5s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m ${seconds}s`;
}

/** Token count abbreviated past 1k (e.g. `3.1k`), matching the context badge. */
function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
}

/**
 * Inert metrics shown after the fold toggle: duration and `↑input ↓output`
 * tokens, each present only when measured. Cached reads are a subset of input,
 * shown parenthetically on ↑input with their share ("↑3.1k (2.8k cached, 90%)")
 * so they read as "of which N cached", not an additive figure. e.g.
 * `12.4s · ↑3.1k (2.8k cached, 90%) ↓5.1k`.
 */
function metricsText(
  collapse: TurnCollapseHead,
  elapsedMs: number | undefined,
  t: Translate,
): string {
  const parts: string[] = [];
  if (elapsedMs !== undefined) {
    parts.push(formatDuration(elapsedMs));
  }
  if (
    collapse.inputTokens !== undefined &&
    collapse.outputTokens !== undefined
  ) {
    const cachedTokens = collapse.cachedTokens ?? 0;
    const cached =
      cachedTokens > 0 && collapse.inputTokens > 0
        ? ` (${formatTokenCount(cachedTokens)} ${t('turn.cached')}, ${Math.round(
            (cachedTokens / collapse.inputTokens) * 100,
          )}%)`
        : '';
    parts.push(
      `↑${formatTokenCount(collapse.inputTokens)}${cached} ↓${formatTokenCount(
        collapse.outputTokens,
      )}`,
    );
  }
  if (collapse.toolCallCount !== undefined && collapse.toolCallCount > 0) {
    parts.push(t('turn.toolCalls', { count: collapse.toolCallCount }));
  }
  return parts.join(' · ');
}

// Must track the same non-duration fields rendered by metricsText().
function hasNonDurationMetrics(collapse: TurnCollapseHead): boolean {
  return (
    (collapse.inputTokens !== undefined &&
      collapse.outputTokens !== undefined) ||
    (collapse.toolCallCount !== undefined && collapse.toolCallCount > 0)
  );
}

/**
 * Wall-clock that re-renders this row once a second while `active`, so a live
 * turn's elapsed advances smoothly instead of jumping per step. Idle (and for
 * completed turns) it never ticks. App code, so `Date.now()` is available.
 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  collapse,
  onToggleCollapse,
}: UserMessageProps) {
  const { t } = useI18n();

  const hasToggle = !!collapse && collapse.hiddenCount > 0;
  const liveStartedAt = collapse?.liveStartedAt;
  const showMetadataRow =
    !!collapse &&
    (hasToggle ||
      liveStartedAt !== undefined ||
      hasNonDurationMetrics(collapse));

  // A live turn ticks `now - liveStartedAt`; a completed turn shows its frozen
  // elapsedMs. The ref clamps the shown value monotonically so it never steps
  // backward when a live turn settles onto its (timestamp-derived) final figure.
  const now = useNowTicker(liveStartedAt !== undefined && showMetadataRow);
  const elapsedSeenRef = useRef(0);
  let displayElapsedMs: number | undefined;
  if (liveStartedAt !== undefined && showMetadataRow) {
    elapsedSeenRef.current = Math.max(
      elapsedSeenRef.current,
      Math.max(0, now - liveStartedAt),
    );
    displayElapsedMs = elapsedSeenRef.current;
  } else if (showMetadataRow && collapse?.elapsedMs !== undefined) {
    elapsedSeenRef.current = Math.max(
      elapsedSeenRef.current,
      collapse.elapsedMs,
    );
    displayElapsedMs = elapsedSeenRef.current;
  } else {
    displayElapsedMs = undefined;
  }

  // The chevron and step count toggle together (one comfortably-sized target);
  // the trailing metrics are inert. A step-less turn has no toggle, just metrics.
  const metrics = collapse ? metricsText(collapse, displayElapsedMs, t) : '';
  const showMetrics = !!metrics && showMetadataRow;

  return (
    <div
      className={
        collapse?.collapsed
          ? `${styles.message} ${styles.collapsedHead}`
          : styles.message
      }
    >
      <span className={styles.prefix}>
        <PromptChevron />
      </span>
      <div className={styles.body}>
        {images && images.length > 0 && (
          <div className={styles.images}>
            {images.map((img, index) => {
              const src = img.data.startsWith('data:')
                ? img.data
                : `data:${img.mimeType};base64,${img.data}`;
              if (!isSafeImageSrc(src)) return null;
              return (
                <img
                  key={index}
                  src={src}
                  alt={`User uploaded image ${index + 1}`}
                  className={styles.imageThumb}
                />
              );
            })}
          </div>
        )}
        {content}
        {collapse && onToggleCollapse && (hasToggle || showMetrics) && (
          <div className={styles.collapseRow}>
            {hasToggle && (
              <button
                type="button"
                className={styles.collapseToggle}
                onClick={() => onToggleCollapse(collapse.turnId)}
                aria-expanded={!collapse.collapsed}
                aria-label={
                  collapse.collapsed ? t('turn.expand') : t('turn.collapse')
                }
                title={
                  collapse.collapsed ? t('turn.expand') : t('turn.collapse')
                }
              >
                {`${collapse.collapsed ? '▸' : '▾'} ${t('turn.executionSteps', {
                  count: collapse.hiddenCount,
                })}`}
              </button>
            )}
            {showMetrics && (
              <span className={styles.collapseMeta}>
                {hasToggle ? ` · ${metrics}` : metrics}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
