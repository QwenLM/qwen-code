import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CalendarClockIcon, PencilIcon, RefreshCwIcon } from 'lucide-react';
import { FileTypeIcon } from '../FileTypeIcon';
import { describeCron } from '../dialogs/scheduledTasksSchedule';
import {
  getComposerTagIconUrl,
  getComposerTagViewModel,
  isBuiltinComposerTagIconUrl,
  isPreviewableFileComposerTag,
  parseUserMessageContentSafely,
  splitComposerTagContentByAnnotations,
} from '../../utils/composerTag';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import { isSafeImageSrc } from './Markdown';
import { useWebShellCustomization } from '../../customization';
import type {
  ComposerTagClickHandler,
  ComposerTagRenderer,
  WebShellComposerTag,
  WebShellComposerTagIconMap,
} from '../../customization';
import type { AttachmentPreviewRequest } from '../../adapters/messageTypes';
import {
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
} from '../../hooks/useComposerCore';
import { useI18n } from '../../i18n';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import { cssUrlVar } from '../../utils/cssUrlVar';
import flashStyles from '../MessageLocateFlash.module.css';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageFile {
  name: string;
  mimeType: string;
  data?: Blob;
  text?: string;
  attachmentId?: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
  files?: UserMessageFile[];
  inputAnnotations?: readonly DaemonInputAnnotation[];
  isLocateFlashing?: boolean;
  sendFailed?: boolean;
  onRetrySend?: () => void;
  onEdit?: () => void;
  /** Click an uploaded image to preview it in the right panel. */
  onImagePreview?: (src: string, alt?: string) => void;
  onAttachmentPreview?: (file: AttachmentPreviewRequest) => void;
}

interface ScheduledTaskRunContent {
  name: string;
  id: string;
  cron: string;
  triggeredAt: string;
  trigger: 'scheduled' | 'manual';
  prompt: string;
}

// Mirrors `SCHEDULED_TASK_RUN_INSTRUCTION` in cli/src/runtime/scheduled-task-run.ts
// (the client cannot import that package): the header `buildScheduledTaskRunPrompt`
// puts ahead of the task's own instructions. Change both together.
const SCHEDULED_TASK_RUN_INSTRUCTION =
  'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.';

function parseScheduledTaskRunContent(
  content: string,
): ScheduledTaskRunContent | null {
  const separator = `\n\n${SCHEDULED_TASK_RUN_INSTRUCTION}\n\n`;
  const separatorIndex = content.indexOf(separator);
  if (separatorIndex < 0) return null;
  const lines = content.slice(0, separatorIndex).split('\n');
  if (lines.length !== 6 || lines[5] !== 'Session: new chat for this run') {
    return null;
  }
  const values = [
    ['Scheduled task: ', lines[0]],
    ['Task ID: ', lines[1]],
    ['Schedule: ', lines[2]],
    ['Triggered at: ', lines[3]],
    ['Trigger: ', lines[4]],
  ] as const;
  if (values.some(([prefix, line]) => !line?.startsWith(prefix))) return null;
  const trigger = lines[4]!.slice('Trigger: '.length);
  if (trigger !== 'scheduled' && trigger !== 'manual') return null;
  return {
    name: lines[0]!.slice('Scheduled task: '.length),
    id: lines[1]!.slice('Task ID: '.length),
    cron: lines[2]!.slice('Schedule: '.length),
    triggeredAt: lines[3]!.slice('Triggered at: '.length),
    trigger,
    prompt: content.slice(separatorIndex + separator.length),
  };
}

function ScheduledTaskRunMessage({ run }: { run: ScheduledTaskRunContent }) {
  const { language, t } = useI18n();
  const triggeredAt = new Date(run.triggeredAt);
  const triggeredAtLabel = Number.isNaN(triggeredAt.getTime())
    ? run.triggeredAt
    : triggeredAt.toLocaleString(language);
  return (
    <div
      className={styles.scheduledTaskRun}
      data-web-shell-scheduled-task-run-message
    >
      <div className={styles.scheduledTaskHeader}>
        <span className={styles.scheduledTaskIcon} aria-hidden="true">
          <CalendarClockIcon />
        </span>
        <span className={styles.scheduledTaskHeading}>
          <span className={styles.scheduledTaskEyebrow}>
            {t('scheduledTasks.runContext.title')}
          </span>
          <strong className={styles.scheduledTaskName}>{run.name}</strong>
        </span>
      </div>
      <div className={styles.scheduledTaskMeta}>
        <span className={styles.scheduledTaskMetaItem} title={run.cron}>
          <span>{t('scheduledTasks.runContext.schedule')}</span>
          <code>{describeCron(run.cron, t)}</code>
        </span>
        <span className={styles.scheduledTaskMetaItem}>
          <span>{t('scheduledTasks.runContext.triggeredAt')}</span>
          <time dateTime={run.triggeredAt}>{triggeredAtLabel}</time>
        </span>
        <span className={styles.scheduledTaskBadge}>
          {t(
            run.trigger === 'manual'
              ? 'scheduledTasks.runContext.trigger.manual'
              : 'scheduledTasks.runContext.trigger.scheduled',
          )}
        </span>
        <span className={styles.scheduledTaskBadge}>
          {t('scheduledTasks.sessionMode.perRun')}
        </span>
      </div>
      <div className={styles.scheduledTaskId}>
        {t('scheduledTasks.runContext.taskId')}: <code>{run.id}</code>
      </div>
      <div className={styles.scheduledTaskPrompt}>{run.prompt}</div>
    </div>
  );
}

function DefaultUserMessageContent({
  composerTagIcons,
  content,
  inputAnnotations,
  onComposerTagClick,
  onFileTagClick,
  renderComposerTag,
  renderComposerTagTooltip,
}: {
  composerTagIcons?: WebShellComposerTagIconMap;
  content: string;
  inputAnnotations?: readonly DaemonInputAnnotation[];
  onComposerTagClick?: ComposerTagClickHandler;
  onFileTagClick?: ComposerTagClickHandler;
  renderComposerTag?: ComposerTagRenderer;
  renderComposerTagTooltip?: ComposerTagRenderer;
}) {
  // Submit-time annotations are the source of truth for reference chips.
  // Unannotated serialized text stays plain text.
  const segments = useMemo(
    () => splitComposerTagContentByAnnotations(content, inputAnnotations),
    [content, inputAnnotations],
  );
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <Fragment key={index}>{segment.text}</Fragment>
        ) : (
          <ReadonlyComposerTag
            composerTagIcons={composerTagIcons}
            key={`${segment.tag.id}:${index}`}
            onComposerTagClick={
              segment.tag.kind === 'file'
                ? isPreviewableFileComposerTag(segment.tag)
                  ? onFileTagClick
                  : onComposerTagClick
                : onComposerTagClick
            }
            renderComposerTag={renderComposerTag}
            renderComposerTagTooltip={renderComposerTagTooltip}
            tag={segment.tag}
            title={segment.tag.serialized}
            preserveCustomKindLabel
          />
        ),
      )}
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  files,
  inputAnnotations,
  isLocateFlashing = false,
  sendFailed = false,
  onRetrySend,
  onEdit,
  onImagePreview,
  onAttachmentPreview,
}: UserMessageProps) {
  const { t } = useI18n();
  const documentMode = useTranscriptRenderMode() === 'document';
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
  const handleComposerTagClick = useCallback<ComposerTagClickHandler>(
    (info) => {
      if (isPreviewableFileComposerTag(info.tag)) {
        onAttachmentPreview?.({
          name: info.tag.value.split(/[\\/]/).pop() ?? info.tag.value,
          workspacePath: info.tag.value,
        });
      }
      onComposerTagClick?.(info);
    },
    [onAttachmentPreview, onComposerTagClick],
  );
  const fileTagClick =
    onAttachmentPreview || onComposerTagClick
      ? handleComposerTagClick
      : undefined;
  const scheduledTaskRun = useMemo(
    () => parseScheduledTaskRunContent(content),
    [content],
  );
  const renderedContent = useMemo(() => {
    if (scheduledTaskRun) {
      return <ScheduledTaskRunMessage run={scheduledTaskRun} />;
    }
    const explicit = renderUserMessageContent?.({
      content,
      images,
      files,
      inputAnnotations,
    });
    if (explicit !== undefined && explicit !== null) return explicit;
    if (inputAnnotations && inputAnnotations.length > 0) {
      return (
        <DefaultUserMessageContent
          composerTagIcons={composerTagIcons}
          content={content}
          inputAnnotations={inputAnnotations}
          onComposerTagClick={onComposerTagClick}
          onFileTagClick={fileTagClick}
          renderComposerTag={renderComposerTag}
          renderComposerTagTooltip={renderComposerTagTooltip}
        />
      );
    }
    const parts = parseUserMessageContentSafely(
      content,
      parseUserMessageContent,
      '[WebShell] failed to parse user message content',
    );
    if (!parts) return content;
    return parts.map((part, index) => {
      if (part.type === 'text') return part.text;
      return (
        <ReadonlyComposerTag
          key={`${part.tag.id}-${index}`}
          tag={part.tag}
          composerTagIcons={composerTagIcons}
          renderComposerTag={renderComposerTag}
          renderComposerTagTooltip={renderComposerTagTooltip}
          onComposerTagClick={
            part.tag.kind === 'file'
              ? isPreviewableFileComposerTag(part.tag)
                ? fileTagClick
                : onComposerTagClick
              : onComposerTagClick
          }
        />
      );
    });
  }, [
    content,
    images,
    files,
    inputAnnotations,
    fileTagClick,
    onComposerTagClick,
    parseUserMessageContent,
    composerTagIcons,
    renderComposerTag,
    renderComposerTagTooltip,
    renderUserMessageContent,
    scheduledTaskRun,
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
    <div className={styles.chatMessageRow} data-web-shell-user-row>
      <div
        className={`${styles.chatMessageColumn}${
          isLocateFlashing && content.trim().length === 0
            ? ` ${flashStyles.flash}`
            : ''
        }`}
      >
        {images && images.length > 0 && (
          <div className={styles.chatImages} data-web-shell-user-images>
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
                  className={`${styles.chatImageThumb}${
                    onImagePreview ? ` ${styles.chatImageThumbInteractive}` : ''
                  }`}
                  onClick={
                    onImagePreview
                      ? () =>
                          onImagePreview(
                            src,
                            t('user.uploadedImage', { index: index + 1 }),
                          )
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
        {files && files.length > 0 && (
          <div className={styles.chatFiles} data-web-shell-user-files>
            {files.map((file, index) => {
              const previewable = Boolean(
                onAttachmentPreview &&
                  (file.data !== undefined ||
                    file.text !== undefined ||
                    file.attachmentId),
              );
              return (
                <span
                  key={`${file.name}-${index}`}
                  className={`${styles.chatFileChip}${
                    previewable ? ` ${styles.chatFileChipPreviewable}` : ''
                  }`}
                  role={previewable ? 'button' : undefined}
                  tabIndex={previewable ? 0 : undefined}
                  onClick={
                    previewable ? () => onAttachmentPreview?.(file) : undefined
                  }
                  onKeyDown={(event) => {
                    if (
                      previewable &&
                      (event.key === 'Enter' || event.key === ' ')
                    ) {
                      event.preventDefault();
                      onAttachmentPreview?.(file);
                    }
                  }}
                >
                  <FileTypeIcon
                    name={file.name}
                    mimeType={file.mimeType}
                    size={16}
                    className={styles.chatFileIcon}
                    aria-hidden="true"
                  />
                  <span className={styles.chatFileName}>{file.name}</span>
                </span>
              );
            })}
          </div>
        )}
        {content.trim().length > 0 && (
          <div
            className={`${styles.chatBubble}${
              scheduledTaskRun ? ` ${styles.scheduledTaskBubble}` : ''
            }${isLocateFlashing ? ` ${flashStyles.flash}` : ''}`}
            data-web-shell-user-bubble
          >
            <div
              ref={contentRef}
              className={`${styles.chatContent} ${
                heightOverflowing && !documentMode && !expanded
                  ? styles.chatContentCollapsed
                  : ''
              }`}
            >
              {renderedContent}
            </div>
            {heightOverflowing && !documentMode && (
              <button
                type="button"
                className={styles.toggleButton}
                onClick={() => setExpanded((value) => !value)}
              >
                <span>
                  {expanded
                    ? t('userMessage.showLess')
                    : t('userMessage.showMore')}
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
        )}
        {sendFailed && onRetrySend && (
          <div className={styles.sendFailure}>
            <span>{t('userMessage.sendFailed')}</span>
            <button
              type="button"
              className={styles.retryButton}
              onClick={onRetrySend}
              aria-label={t('userMessage.retrySend')}
              title={t('userMessage.retrySend')}
            >
              <RefreshCwIcon aria-hidden="true" />
              <span>{t('common.retry')}</span>
            </button>
          </div>
        )}
        {onEdit && (
          <button
            type="button"
            className={styles.editButton}
            onClick={onEdit}
            aria-label="Edit message"
            title="Edit message"
          >
            <PencilIcon aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});

function getTagText(tag: WebShellComposerTag): string {
  return getComposerTagDisplay(tag);
}

export function ReadonlyComposerTag({
  tag,
  composerTagIcons,
  renderComposerTag,
  renderComposerTagTooltip,
  onComposerTagClick,
  title,
  preserveCustomKindLabel = false,
}: {
  tag: WebShellComposerTag;
  composerTagIcons: WebShellComposerTagIconMap | undefined;
  renderComposerTag: ComposerTagRenderer | undefined;
  renderComposerTagTooltip: ComposerTagRenderer | undefined;
  onComposerTagClick: ComposerTagClickHandler | undefined;
  title?: string;
  preserveCustomKindLabel?: boolean;
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
  const viewModel = preserveCustomKindLabel
    ? getComposerTagViewModel(tag, composerTagIcons)
    : null;
  const rawTagLabel = getComposerTagLabel(tag);
  const tagValue = viewModel?.tagValue ?? getComposerTagValue(tag);
  const tagLabel = viewModel?.tagLabel ?? (tag.kind ? '' : rawTagLabel);
  const fallback = viewModel?.fallback ?? tag.id;
  const iconUrl =
    tag.icon ??
    viewModel?.iconUrl ??
    getComposerTagIconUrl(tag.kind, composerTagIcons);
  const safeIconUrl =
    iconUrl && (isBuiltinComposerTagIconUrl(iconUrl) || isSafeImageSrc(iconUrl))
      ? iconUrl
      : undefined;
  return (
    <span
      className={`${styles.messageTag}${
        clickable ? ` ${styles.messageTagClickable}` : ''
      }`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={title ?? getTagText(tag)}
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
          {safeIconUrl && (
            <span
              className={styles.messageTagIcon}
              style={cssUrlVar('--user-message-tag-icon-url', safeIconUrl)}
              aria-hidden="true"
            />
          )}
          {tagLabel && (
            <span className={styles.messageTagLabel}>{tagLabel}</span>
          )}
          {tagValue ? (
            <span className={styles.messageTagValue}>{tagValue}</span>
          ) : !tagLabel ? (
            <span className={styles.messageTagLabel}>{fallback}</span>
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
