import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Markdown } from './Markdown';
import { CompactModeContext } from '../../App';
import {
  useWebShellCustomization,
  type WebShellAssistantTurnFooterRenderInfo,
} from '../../customization';
import { useI18n } from '../../i18n';
import { formatTimestamp } from '../MessageTimestamp';
import type { DaemonSessionGenerationEvent } from '@qwen-code/sdk/daemon';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import flashStyles from '../MessageLocateFlash.module.css';
import styles from './AssistantMessage.module.css';

interface AssistantMessageProps {
  content: string;
  isStreaming?: boolean;
  timestamp?: number;
  onBranchSession?: () => void;
  showFooterActions?: boolean;
  showBranchAction?: boolean;
  isLocateFlashing?: boolean;
  customFooterInfo?: WebShellAssistantTurnFooterRenderInfo;
}

export const AssistantMessage = memo(function AssistantMessage({
  content,
  isStreaming,
  timestamp,
  onBranchSession,
  showFooterActions = false,
  showBranchAction = false,
  isLocateFlashing = false,
  customFooterInfo,
}: AssistantMessageProps) {
  const { t } = useI18n();
  const { renderAssistantTurnFooter } = useWebShellCustomization();
  const [copied, setCopied] = useState(false);
  const showFooter = !!content && !isStreaming && showFooterActions;
  const customFooter = useMemo(
    () =>
      customFooterInfo
        ? renderAssistantTurnFooter?.(customFooterInfo)
        : undefined,
    [customFooterInfo, renderAssistantTurnFooter],
  );
  const handleCopy = useCallback(() => {
    const write = navigator.clipboard?.writeText(content);
    if (!write) {
      return;
    }
    void write
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [content]);
  return (
    <div className={styles.message}>
      {content && (
        <div
          className={`${styles.content}${
            isLocateFlashing ? ` ${flashStyles.flash}` : ''
          }`}
        >
          <div className={styles.contentBody}>
            <Markdown
              content={content}
              source="assistant"
              isStreaming={isStreaming}
            />
          </div>
        </div>
      )}
      {customFooter && (
        <div className={styles.customFooter}>{customFooter}</div>
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
  messageId: string;
  content: string;
  isStreaming?: boolean;
  timestamp?: number;
  isLocateFlashing?: boolean;
  generateContent?: SessionContentGenerator;
}

export type SessionContentGenerator = (
  prompt: string,
  opts?: { signal?: AbortSignal },
) => AsyncGenerator<DaemonSessionGenerationEvent>;

interface ThinkingTranslation {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

const thinkingTranslationCache = new Map<string, ThinkingTranslation>();
const THINKING_TRANSLATION_CACHE_MAX_ENTRIES = 200;

function cacheThinkingTranslation(
  key: string,
  translation: ThinkingTranslation,
): void {
  thinkingTranslationCache.delete(key);
  thinkingTranslationCache.set(key, translation);
  if (thinkingTranslationCache.size <= THINKING_TRANSLATION_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldestKey = thinkingTranslationCache.keys().next().value;
  if (oldestKey !== undefined) thinkingTranslationCache.delete(oldestKey);
}

export const ThinkingMessage = memo(function ThinkingMessage({
  messageId,
  content,
  isStreaming,
  timestamp,
  isLocateFlashing = false,
  generateContent,
}: ThinkingMessageProps) {
  const { language, t } = useI18n();
  const compactMode = useContext(CompactModeContext);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const thinkingActive = isStreaming === true;
  const startTimeRef = useRef(timestamp ?? Date.now());
  const sawActiveRef = useRef(thinkingActive);
  const [now, setNow] = useState(() => Date.now());
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [translationOpen, setTranslationOpen] = useState(false);
  const [translation, setTranslation] = useState<ThinkingTranslation>();
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationThinking, setTranslationThinking] = useState(false);
  const [translationError, setTranslationError] = useState(false);
  const translationAbortRef = useRef<AbortController | undefined>(undefined);

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

  const thinkingDurationMs =
    thinkingActive || finishedAt !== null
      ? (thinkingActive ? now : finishedAt!) - startTimeRef.current
      : undefined;
  const thinkingSummaryKey = getThinkingSummaryKey({
    isStreaming,
    durationMs: thinkingDurationMs,
  });
  const thinkingDuration =
    thinkingDurationMs !== undefined
      ? formatThinkingDuration(thinkingDurationMs)
      : '';

  const handleToggle = useCallback(() => {
    setThinkingExpanded((v) => !v);
  }, []);

  useEffect(
    () => () => {
      translationAbortRef.current?.abort();
    },
    [],
  );

  const translate = useCallback(
    async (force = false) => {
      if (isStreaming || !generateContent || (translationLoading && !force)) {
        return;
      }
      const cacheKey = `${language}:${messageId}:${content}`;
      const cached = thinkingTranslationCache.get(cacheKey);
      if (cached && !force) {
        cacheThinkingTranslation(cacheKey, cached);
        setTranslation(cached);
        return;
      }

      if (force) thinkingTranslationCache.delete(cacheKey);
      translationAbortRef.current?.abort();
      const controller = new AbortController();
      translationAbortRef.current = controller;
      setTranslation({ text: '' });
      setTranslationThinking(false);
      setTranslationError(false);
      setTranslationLoading(true);
      let text = '';
      let completed = false;
      try {
        const targetLanguage =
          language === 'zh-CN' ? 'Simplified Chinese' : 'English';
        const prompt = `Translate the following model reasoning into ${targetLanguage}. Preserve its meaning and Markdown formatting. Output only the translation.\n\n${content}`;
        for await (const event of generateContent(prompt, {
          signal: controller.signal,
        })) {
          if (translationAbortRef.current !== controller) return;
          if (event.type === 'thinking') {
            setTranslationThinking(true);
          } else if (event.type === 'delta') {
            setTranslationThinking(false);
            text += event.text;
            setTranslation({ text });
          } else if (event.type === 'done') {
            if (!text.trim()) throw new Error('Translation was empty');
            completed = true;
            const result = {
              text,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
            };
            cacheThinkingTranslation(cacheKey, result);
            setTranslation(result);
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
        if (!completed) throw new Error('Translation stream ended early');
      } catch {
        if (!controller.signal.aborted) setTranslationError(true);
      } finally {
        if (translationAbortRef.current === controller) {
          translationAbortRef.current = undefined;
          setTranslationThinking(false);
          setTranslationLoading(false);
        }
      }
    },
    [
      content,
      generateContent,
      isStreaming,
      language,
      messageId,
      translationLoading,
    ],
  );

  const handleTranslationOpenChange = useCallback(
    (open: boolean) => {
      setTranslationOpen(open);
      if (open) void translate();
    },
    [translate],
  );

  const handleCancelOrCloseTranslation = useCallback(() => {
    const controller = translationAbortRef.current;
    translationAbortRef.current = undefined;
    controller?.abort();
    setTranslationThinking(false);
    setTranslationLoading(false);
    setTranslationOpen(false);
  }, []);

  return (
    <div
      className={`${styles.message}${
        isLocateFlashing ? ` ${flashStyles.flash}` : ''
      }`}
    >
      {content && !compactMode && (
        <div className={styles.thinking}>
          <div className={styles.thinkingBody}>
            <div
              className={`${styles.thinkingHeader}${
                thinkingExpanded ? ` ${styles.thinkingHeaderExpanded}` : ''
              }`}
              onClick={(event) => {
                if (event.currentTarget.contains(event.target as Node)) {
                  handleToggle();
                }
              }}
            >
              <button
                type="button"
                className={styles.thinkingSummary}
                aria-expanded={thinkingExpanded}
                title={
                  thinkingExpanded
                    ? t('thinking.collapse')
                    : t('thinking.expand')
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
                  {t(
                    thinkingSummaryKey,
                    thinkingDuration ? { duration: thinkingDuration } : {},
                  )}
                </span>
              </button>
              {language === 'zh-CN' && !thinkingActive && generateContent && (
                <Popover
                  open={translationOpen}
                  onOpenChange={handleTranslationOpenChange}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      className={styles.translateButton}
                      title={t('thinking.translate')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {t('thinking.translate')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className={styles.translationPopover}
                  >
                    <div className={styles.translationTitle}>
                      {t('thinking.translation')}
                    </div>
                    {translationError ? (
                      <div className={styles.translationError}>
                        {t('thinking.translationFailed')}
                      </div>
                    ) : translation?.text ? (
                      <div
                        className={`${styles.thinkingExpandedWrap} ${styles.translationContent}`}
                      >
                        <Markdown
                          content={translation.text}
                          source="thinking"
                          isStreaming={translationLoading}
                        />
                      </div>
                    ) : (
                      <div className={styles.translationPending}>
                        {t(
                          translationThinking
                            ? 'thinking.translationThinking'
                            : 'thinking.translating',
                        )}
                      </div>
                    )}
                    <div className={styles.translationFooter}>
                      <div className={styles.translationUsage}>
                        {!translationLoading && translation?.text && (
                          <>
                            <span>
                              {t('thinking.inputTokens', {
                                count: translation.inputTokens ?? '--',
                              })}
                            </span>
                            <span>
                              {t('thinking.outputTokens', {
                                count: translation.outputTokens ?? '--',
                              })}
                            </span>
                          </>
                        )}
                      </div>
                      <div className={styles.translationActions}>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => void translate(true)}
                        >
                          {t('thinking.retranslate')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          disabled={
                            !translationLoading &&
                            !translation?.text &&
                            !translationError
                          }
                          onClick={handleCancelOrCloseTranslation}
                        >
                          {t(
                            translationLoading
                              ? 'thinking.cancelTranslation'
                              : 'thinking.closeTranslation',
                          )}
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              <span
                className={
                  thinkingExpanded
                    ? styles.thinkingChevronDown
                    : styles.thinkingChevronRight
                }
                aria-hidden="true"
              />
            </div>
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
                    isStreaming={isStreaming}
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
  durationMs,
}: {
  isStreaming?: boolean;
  durationMs?: number;
}): 'thinking.running' | 'thinking.done' | 'thinking.doneBriefly' {
  if (isStreaming) return 'thinking.running';
  return durationMs !== undefined && durationMs < 1_000
    ? 'thinking.doneBriefly'
    : 'thinking.done';
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
