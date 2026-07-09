import {
  memo,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isSafeImageSrc } from './Markdown';
import { useWebShellCustomization } from '../../customization';
import type {
  ComposerTagClickHandler,
  ComposerTagRenderer,
  WebShellComposerTag,
  WebShellComposerTagIconMap,
  WebShellUserMessagePart,
} from '../../customization';
import {
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
} from '../../hooks/useComposerCore';
import { useI18n } from '../../i18n';
import { cssUrlVar } from '../../utils/cssUrlVar';
import { getComposerTagIconUrl } from '../composerTagIcons';
import flashStyles from '../MessageLocateFlash.module.css';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
  isLocateFlashing?: boolean;
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  isLocateFlashing = false,
}: UserMessageProps) {
  const { t } = useI18n();
  const {
    parseUserMessageContent,
    renderUserMessageContent,
    composerTagIcons,
    renderComposerTag,
    renderComposerTagTooltip,
    onComposerTagClick,
  } = useWebShellCustomization();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [heightOverflowing, setHeightOverflowing] = useState(false);
  const renderedContent = useMemo(() => {
    const explicit = renderUserMessageContent?.({ content, images });
    if (explicit !== undefined && explicit !== null) return explicit;
    let parts: readonly WebShellUserMessagePart[] | undefined | null;
    try {
      parts = parseUserMessageContent?.(content);
    } catch (error) {
      console.warn('[WebShell] failed to parse user message content', error);
      return content;
    }
    if (!parts || parts.length === 0) return content;
    return parts.map((part, index) => {
      if (part.type === 'text') return part.text;
      return (
        <UserMessageTag
          key={`${part.tag.id}-${index}`}
          tag={part.tag}
          composerTagIcons={composerTagIcons}
          renderComposerTag={renderComposerTag}
          renderComposerTagTooltip={renderComposerTagTooltip}
          onComposerTagClick={onComposerTagClick}
        />
      );
    });
  }, [
    content,
    images,
    onComposerTagClick,
    parseUserMessageContent,
    composerTagIcons,
    renderComposerTag,
    renderComposerTagTooltip,
    renderUserMessageContent,
  ]);

  const measureOverflow = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setHeightOverflowing(el.scrollHeight > 400);
  }, []);

  useLayoutEffect(() => {
    setExpanded(false);
    measureOverflow();
  }, [content, images?.length, measureOverflow]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureOverflow]);

  return (
    <div className={styles.chatMessageRow}>
      <div
        className={`${styles.chatBubble}${
          isLocateFlashing ? ` ${flashStyles.flash}` : ''
        }`}
      >
        <div
          ref={contentRef}
          className={`${styles.chatContent} ${
            heightOverflowing && !expanded ? styles.chatContentCollapsed : ''
          }`}
        >
          {images && images.length > 0 && (
            <div className={styles.chatImages}>
              {images.map((img, index) => {
                const src = img.data.startsWith('data:')
                  ? img.data
                  : `data:${img.mimeType};base64,${img.data}`;
                if (!isSafeImageSrc(src)) return null;
                return (
                  <img
                    key={index}
                    src={src}
                    alt={t('user.uploadedImage', { index: index + 1 })}
                    className={styles.chatImageThumb}
                    onLoad={measureOverflow}
                  />
                );
              })}
            </div>
          )}
          {renderedContent}
        </div>
        {heightOverflowing && (
          <button
            type="button"
            className={styles.toggleButton}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>
              {expanded ? t('userMessage.showLess') : t('userMessage.showMore')}
            </span>
            <svg
              className={`${styles.toggleIcon} ${
                expanded ? styles.toggleIconExpanded : ''
              }`}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="m4 6 4 4 4-4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

function getTagText(tag: WebShellComposerTag): string {
  return getComposerTagDisplay(tag);
}

function UserMessageTag({
  tag,
  composerTagIcons,
  renderComposerTag,
  renderComposerTagTooltip,
  onComposerTagClick,
}: {
  tag: WebShellComposerTag;
  composerTagIcons: WebShellComposerTagIconMap | undefined;
  renderComposerTag: ComposerTagRenderer | undefined;
  renderComposerTagTooltip: ComposerTagRenderer | undefined;
  onComposerTagClick: ComposerTagClickHandler | undefined;
}) {
  const info = { tag, placement: 'user-message' as const, readonly: true };
  let custom: ReactNode | null | undefined;
  let tooltip: ReactNode | null | undefined;
  try {
    custom = renderComposerTag?.(info);
  } catch (error) {
    console.warn('[WebShell] user message tag render failed', error);
  }
  try {
    tooltip = renderComposerTagTooltip?.(info);
  } catch (error) {
    console.warn('[WebShell] user message tag tooltip render failed', error);
  }
  const clickable = Boolean(onComposerTagClick);
  const rawTagLabel = getComposerTagLabel(tag);
  const tagValue = getComposerTagValue(tag);
  const tagLabel = tag.kind ? '' : rawTagLabel;
  const iconUrl = tag.icon ?? getComposerTagIconUrl(tag.kind, composerTagIcons);
  return (
    <span
      className={`${styles.messageTag}${
        clickable ? ` ${styles.messageTagClickable}` : ''
      }`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={getTagText(tag)}
      onClick={(event) => {
        if (!clickable) return;
        event.stopPropagation();
        onComposerTagClick?.({
          ...info,
          anchorRect: event.currentTarget.getBoundingClientRect(),
        });
      }}
      onKeyDown={(event) => {
        if (!clickable) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onComposerTagClick?.({
          ...info,
          anchorRect: event.currentTarget.getBoundingClientRect(),
        });
      }}
    >
      {custom ?? (
        <>
          {iconUrl && (
            <span
              className={styles.messageTagIcon}
              style={cssUrlVar('--user-message-tag-icon-url', iconUrl)}
              aria-hidden="true"
            />
          )}
          {tagLabel && (
            <span className={styles.messageTagLabel}>{tagLabel}</span>
          )}
          {tagValue ? (
            <span className={styles.messageTagValue}>{tagValue}</span>
          ) : !tagLabel ? (
            <span className={styles.messageTagLabel}>{tag.id}</span>
          ) : null}
        </>
      )}
      {tooltip !== undefined && tooltip !== null && (
        <span className={styles.messageTagTooltip} role="tooltip">
          {tooltip}
        </span>
      )}
    </span>
  );
}
