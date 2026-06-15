import { memo } from 'react';
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

type Translate = (key: string, vars?: Record<string, string | number>) => string;

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
 * Summary shown beside the fold chevron — identical whether the turn is
 * collapsed or expanded, so toggling only flips the chevron glyph and never
 * reflows the row. The step count is always present; duration and
 * `↑input ↓output` tokens join only when measured. e.g.
 * `3 steps · 12.4s · ↑3.1k ↓5.1k`.
 */
function collapseMetaText(collapse: TurnCollapseHead, t: Translate): string {
  const parts: string[] = [];
  // A step-less turn (nothing to fold) still shows time/tokens, just no count.
  if (collapse.hiddenCount > 0) {
    parts.push(t('turn.hiddenSteps', { count: collapse.hiddenCount }));
  }
  if (collapse.elapsedMs !== undefined) {
    parts.push(formatDuration(collapse.elapsedMs));
  }
  if (collapse.inputTokens !== undefined && collapse.outputTokens !== undefined) {
    // Cached reads are a subset of input — shown parenthetically on ↑input so
    // it reads as "of which N cached", not an extra additive figure.
    const cached =
      collapse.cachedTokens && collapse.cachedTokens > 0
        ? ` (${formatTokenCount(collapse.cachedTokens)} ${t('turn.cached')})`
        : '';
    parts.push(
      `↑${formatTokenCount(collapse.inputTokens)}${cached} ↓${formatTokenCount(
        collapse.outputTokens,
      )}`,
    );
  }
  return parts.join(' · ');
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  collapse,
  onToggleCollapse,
}: UserMessageProps) {
  const { t } = useI18n();
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
        {collapse && onToggleCollapse && (
          <div className={styles.collapseRow}>
            {collapse.hiddenCount > 0 && (
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
                {collapse.collapsed ? '▸' : '▾'}
              </button>
            )}
            <span className={styles.collapseMeta}>
              {collapseMetaText(collapse, t)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
