import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getComposerTagViewModel,
  splitComposerTagContent,
} from '../../utils/composerTag';
import { isSafeImageSrc } from './Markdown';
import {
  useWebShellCustomization,
  type WebShellComposerTag,
  type WebShellComposerTagIconMap,
} from '../../customization';
import { useI18n } from '../../i18n';
import { cssUrlVar } from '../../utils/cssUrlVar';
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

function UserMessageReferenceChip({
  composerTagIcons,
  tag,
}: {
  composerTagIcons?: WebShellComposerTagIconMap;
  tag: WebShellComposerTag;
}) {
  const { tagLabel, tagValue, iconUrl, fallback } = getComposerTagViewModel(
    tag,
    composerTagIcons,
  );
  return (
    <span className={styles.referenceChip} title={tag.serialized}>
      {iconUrl && (
        <span
          className={styles.referenceIcon}
          style={cssUrlVar('--composer-tag-icon-url', iconUrl)}
          aria-hidden="true"
        />
      )}
      {tagLabel && <span className={styles.referenceLabel}>{tagLabel}</span>}
      <span className={styles.referenceValue}>{tagValue || fallback}</span>
    </span>
  );
}

function DefaultUserMessageContent({
  composerTagIcons,
  content,
}: {
  composerTagIcons?: WebShellComposerTagIconMap;
  content: string;
}) {
  // The default user renderer upgrades serialized @ references to chips while
  // still allowing hosts to replace message rendering entirely.
  const segments = useMemo(() => splitComposerTagContent(content), [content]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <UserMessageReferenceChip
            composerTagIcons={composerTagIcons}
            key={`${segment.tag.id}:${index}`}
            tag={segment.tag}
          />
        ),
      )}
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  isLocateFlashing = false,
}: UserMessageProps) {
  const { t } = useI18n();
  const { composerTagIcons, renderUserMessageContent } =
    useWebShellCustomization();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [heightOverflowing, setHeightOverflowing] = useState(false);
  const renderedContent = useMemo(
    () =>
      renderUserMessageContent?.({ content, images }) ?? (
        <DefaultUserMessageContent
          composerTagIcons={composerTagIcons}
          content={content}
        />
      ),
    [composerTagIcons, content, images, renderUserMessageContent],
  );

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
