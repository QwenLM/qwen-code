import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Markdown } from './Markdown';
import { CompactModeContext } from '../../App';
import { useI18n } from '../../i18n';
import { formatTimestamp } from '../MessageTimestamp';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  isStreaming?: boolean;
  timestamp?: number;
  onBranchSession?: () => void;
  showFooterActions?: boolean;
  showBranchAction?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  isStreaming,
  timestamp,
  onBranchSession,
  showFooterActions = false,
  showBranchAction = false,
}: AssistantMessageProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const showFooter = !!content && !isStreaming && showFooterActions;
  const handleCopy = useCallback(() => {
    const write = navigator.clipboard?.writeText(content);
    if (!write) {
      return;
    }
    void write.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [content]);
  return (
    <div className={styles.message}>
      {content && (
        <div className={styles.content}>
          <div className={styles.contentBody}>
            <Markdown
              content={content}
              source="assistant"
              deferMermaid={isStreaming}
              enhanceTables={!isStreaming}
            />
          </div>
        </div>
      )}
      {showFooter && (
        <div className={styles.messageFooter}>
          <button
            type="button"
            className={styles.copyButton}
            title={t('assistant.copy')}
            aria-label={t('assistant.copy')}
            onClick={handleCopy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          {showBranchAction && onBranchSession && (
            <button
              type="button"
              className={styles.copyButton}
              title={t('assistant.branch')}
              aria-label={t('assistant.branch')}
              onClick={onBranchSession}
            >
              <BranchIcon />
            </button>
          )}
          {timestamp !== undefined && (
            <span className={styles.footerTime} aria-hidden="true">
              {formatTimestamp(timestamp)}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5.2 4.4V3.2c0-.7.5-1.2 1.2-1.2h5.4c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2h-1.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
      <rect
        x="3"
        y="5.2"
        width="7.8"
        height="7.8"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m3.5 8.3 3 3L12.8 5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 3.5v5.2c0 2.1 1.7 3.8 3.8 3.8H11"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M5 8.2h3.2c1.5 0 2.8-1.2 2.8-2.8V4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <circle cx="5" cy="3.5" r="1.5" fill="currentColor" />
      <circle cx="11" cy="4" r="1.5" fill="currentColor" />
      <circle cx="11" cy="12.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

interface ThinkingMessageProps {
  content: string;
  isStreaming?: boolean;
  timestamp?: number;
}

export const ThinkingMessage = memo(function ThinkingMessage({
  content,
  isStreaming,
  timestamp,
}: ThinkingMessageProps) {
  const { t } = useI18n();
  const compactMode = useContext(CompactModeContext);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const thinkingSummaryKey = getThinkingSummaryKey({ isStreaming });
  const thinkingActive = thinkingSummaryKey === 'thinking.running';
  const startTimeRef = useRef(timestamp ?? Date.now());
  const sawActiveRef = useRef(thinkingActive);
  const [now, setNow] = useState(() => Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!content || !thinkingActive) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [content, thinkingActive]);

  useEffect(() => {
    if (!content) return;
    if (thinkingActive) {
      sawActiveRef.current = true;
      setFinishedAt(null);
      return;
    }
    if (sawActiveRef.current && finishedAt === null) {
      setFinishedAt(Date.now());
    }
  }, [content, finishedAt, thinkingActive]);

  const thinkingDuration =
    thinkingActive || finishedAt
      ? formatThinkingDuration(
          (thinkingActive ? now : finishedAt!) - startTimeRef.current,
        )
      : '';

  const handleToggle = useCallback(() => {
    setThinkingExpanded((v) => !v);
  }, []);

  return (
    <div className={styles.message}>
      {content && !compactMode && (
        <div className={styles.thinking}>
          <div className={styles.thinkingBody}>
            <button
              type="button"
              className={styles.thinkingSummary}
              onClick={handleToggle}
              aria-expanded={thinkingExpanded}
              title={
                thinkingExpanded ? t('thinking.collapse') : t('thinking.expand')
              }
            >
              <span className={styles.thinkingSummaryIcon} aria-hidden="true">
                <ThinkingDoneIcon />
              </span>
              <span
                className={
                  thinkingActive
                    ? `${styles.thinkingSummaryText} ${styles.thinkingSummaryTextActive}`
                    : styles.thinkingSummaryText
                }
              >
                {t(thinkingSummaryKey, {
                  duration: thinkingActive ? thinkingDuration : '',
                })}
              </span>
              <span
                className={
                  thinkingExpanded
                    ? styles.thinkingChevronDown
                    : styles.thinkingChevronRight
                }
                aria-hidden="true"
              />
            </button>
            <div
              className={
                thinkingExpanded
                  ? styles.thinkingExpandedClip
                  : `${styles.thinkingExpandedClip} ${styles.thinkingExpandedCollapsed}`
              }
            >
              <div className={styles.thinkingExpandedInner}>
                <div className={styles.thinkingExpandedWrap}>
                  <Markdown
                    content={content}
                    source="thinking"
                    deferMermaid={isStreaming}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export function getThinkingSummaryKey({
  isStreaming,
}: {
  isStreaming?: boolean;
}): 'thinking.running' | 'thinking.done' {
  return isStreaming ? 'thinking.running' : 'thinking.done';
}

export function formatThinkingDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function ThinkingDoneIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7.2 15.2h4"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <path
        d="M6.5 13.1h5.4"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <path
        d="M9.1 2.8c-3 0-5.1 2.3-5.1 5 0 1.7.8 3.1 2.1 4 .5.4.8.8.8 1.4h4.5c0-.6.3-1 .8-1.4 1.3-.9 2.1-2.3 2.1-4 0-.8-.2-1.6-.6-2.3"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.2 1.8 14 3.6l1.8.8-1.8.8-.8 1.8-.8-1.8-1.8-.8 1.8-.8.8-1.8Z"
        fill="currentColor"
      />
    </svg>
  );
}
