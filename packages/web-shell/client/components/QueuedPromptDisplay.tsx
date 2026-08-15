/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import { Fragment } from 'react';
import deleteIconUrl from '../assets/icons/delete.svg';
import editIconUrl from '../assets/icons/edit.svg';
import queueIconUrl from '../assets/icons/queue.svg';
import type { getTranslator } from '../i18n';
import {
  useWebShellCustomization,
  type UserMessageContentParser,
  type WebShellComposerTag,
} from '../customization';
import {
  parseUserMessageContentSafely,
  splitComposerTagContentByAnnotations,
} from '../utils/composerTag';
import { cssUrlVar } from '../utils/cssUrlVar';
import { ReadonlyComposerTag } from './messages/UserMessage';
import { isSafeImageSrc } from './messages/Markdown';
import styles from '../App.module.css';

const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 240;

type QueuedPromptPreviewPart =
  | { type: 'text'; text: string }
  | {
      type: 'tag';
      tag: WebShellComposerTag;
      preserveCustomKindLabel: boolean;
    };

function getTagDisplayText(tag: WebShellComposerTag): string {
  return tag.value?.trim() || tag.label?.trim() || tag.id;
}

function getQueuedPromptParts(
  prompt: QueuedPrompt,
  parser: UserMessageContentParser | undefined,
): QueuedPromptPreviewPart[] {
  if (prompt.inputAnnotations && prompt.inputAnnotations.length > 0) {
    return splitComposerTagContentByAnnotations(
      prompt.text,
      prompt.inputAnnotations,
    ).map((segment) =>
      segment.type === 'text'
        ? segment
        : {
            type: 'tag',
            tag: segment.tag,
            preserveCustomKindLabel: true,
          },
    );
  }

  const parsed = parseUserMessageContentSafely(
    prompt.text,
    parser,
    '[WebShell] failed to parse queued prompt content',
    { requireSourcePreservation: true },
  );
  if (!parsed) return [{ type: 'text', text: prompt.text }];
  return parsed.map((part) =>
    part.type === 'text'
      ? part
      : { type: 'tag', tag: part.tag, preserveCustomKindLabel: false },
  );
}

function truncateQueuedPromptParts(parts: readonly QueuedPromptPreviewPart[]): {
  parts: QueuedPromptPreviewPart[];
  truncated: boolean;
} {
  const preview: QueuedPromptPreviewPart[] = [];
  let remaining = MAX_QUEUED_PROMPT_PREVIEW_CHARS;
  let truncated = false;

  for (const part of parts) {
    if (part.type === 'tag') {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const visibleLength = getTagDisplayText(part.tag).length;
      if (visibleLength > remaining) {
        truncated = true;
        break;
      }
      preview.push(part);
      remaining -= visibleLength;
      continue;
    }

    let text = part.text.replace(/\s+/g, ' ');
    if (preview.length === 0) text = text.trimStart();
    if (!text) continue;
    if (text.length > remaining) {
      if (remaining > 0)
        preview.push({ type: 'text', text: text.slice(0, remaining) });
      truncated = true;
      break;
    }
    preview.push({ type: 'text', text });
    remaining -= text.length;
  }

  const last = preview[preview.length - 1];
  if (last?.type === 'text') {
    const text = last.text.trimEnd();
    if (text) last.text = text;
    else preview.pop();
  }
  return { parts: preview, truncated };
}

export interface QueuedPrompt {
  id: number;
  sessionId?: string;
  text: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  onComplete?: () => void;
  onAdmitted?: () => void;
  serverPromptId?: string;
  serverState?: 'submitting' | 'queued' | 'running';
  midTurnState?: 'submitting' | 'queued';
  midTurnMessageId?: string;
  midTurnFailedAction?: 'delete' | 'edit';
  isEditing?: boolean;
  isRemoving?: boolean;
  payloadCompleteness?: 'complete' | 'summary-only';
  admissionOutcome?: 'unknown';
  payloadAvailable?: boolean;
}

export function QueuedPromptDisplay({
  prompts,
  t,
  canMutateMidTurn = false,
  onDelete,
  onEdit,
  onRestoreUnknown,
  onDiscardUnknown,
  onImagePreview,
}: {
  prompts: readonly QueuedPrompt[];
  t: ReturnType<typeof getTranslator>;
  canMutateMidTurn?: boolean;
  onDelete: (id: number) => void;
  onEdit: (id: number) => void;
  onRestoreUnknown?: (id: number) => void;
  onDiscardUnknown?: (id: number) => void;
  onImagePreview?: (src: string, alt?: string) => void;
}) {
  const {
    parseUserMessageContent,
    composerTagIcons,
    renderComposerTag,
    renderComposerTagTooltip,
    onComposerTagClick,
  } = useWebShellCustomization();
  if (prompts.length === 0) return null;
  const latestPrompt = prompts[prompts.length - 1];
  const showQueueShortcuts =
    latestPrompt !== undefined &&
    latestPrompt.midTurnState === undefined &&
    latestPrompt.serverState !== 'submitting' &&
    latestPrompt.serverState !== 'running' &&
    !latestPrompt.isEditing &&
    !latestPrompt.isRemoving &&
    latestPrompt.payloadCompleteness !== 'summary-only' &&
    latestPrompt.admissionOutcome !== 'unknown';
  const mayContainDuplicateAdmission =
    prompts.some((prompt) => prompt.admissionOutcome === 'unknown') &&
    prompts.some(
      (prompt) =>
        prompt.payloadCompleteness === 'summary-only' &&
        prompt.serverPromptId !== undefined,
    );

  return (
    <div className={styles.queuedPrompts}>
      {mayContainDuplicateAdmission ? (
        <div className={styles.queuedPromptAmbiguity} role="status">
          {t('queue.mayCorrespond')}
        </div>
      ) : null}
      {prompts.map((prompt) => {
        const preview = truncateQueuedPromptParts(
          getQueuedPromptParts(prompt, parseUserMessageContent),
        );
        const safeImages = (prompt.images ?? []).flatMap((image, index) => {
          const src = `data:${image.media_type};base64,${image.data}`;
          return isSafeImageSrc(src) ? [{ index, src }] : [];
        });
        const imageCount = safeImages.length;
        const fileCount = prompt.files?.length ?? 0;
        const isSubmitting = prompt.serverState === 'submitting';
        const isQueued = prompt.serverState === 'queued';
        const isRunning = prompt.serverState === 'running';
        const isMidTurnPending = prompt.midTurnState !== undefined;
        const isMidTurnLocked =
          prompt.midTurnState === 'submitting' ||
          (prompt.midTurnState === 'queued' && !prompt.midTurnMessageId);
        const isSummaryOnly = prompt.payloadCompleteness === 'summary-only';
        const isAdmissionUnknown = prompt.admissionOutcome === 'unknown';
        const hasUnknownPayload =
          isAdmissionUnknown && prompt.payloadAvailable !== false;
        const showActions = !isMidTurnPending || canMutateMidTurn;
        const isRemoving = prompt.isRemoving === true;
        const hasStateSpinner =
          isSubmitting ||
          prompt.midTurnState === 'submitting' ||
          prompt.isEditing === true ||
          isRemoving;
        const isBusy =
          isSubmitting ||
          isRunning ||
          isMidTurnLocked ||
          isAdmissionUnknown ||
          prompt.isEditing === true ||
          isRemoving;
        const isEditDisabled = isBusy || isSummaryOnly;
        let editTitle = t('queue.editTip');
        if (isEditDisabled) {
          editTitle = isSummaryOnly
            ? t('queue.summaryEditDisabled')
            : isAdmissionUnknown
              ? t('queue.admissionUnknown')
              : t('queue.submittingDisabled');
        }
        const deleteTitle = isBusy
          ? t('queue.submittingDisabled')
          : t('queue.deleteTip');
        return (
          <div key={prompt.id} className={styles.queuedPrompt}>
            <span className={styles.queuedPromptIcon} aria-hidden="true">
              <span
                className={styles.queuedPromptMaskIcon}
                style={cssUrlVar('--queued-icon-url', queueIconUrl)}
              />
            </span>
            <span className={styles.queuedPromptText}>
              {preview.parts.map((part, index) =>
                part.type === 'text' ? (
                  <Fragment key={index}>{part.text}</Fragment>
                ) : (
                  <ReadonlyComposerTag
                    key={`${part.tag.id}:${index}`}
                    tag={part.tag}
                    composerTagIcons={composerTagIcons}
                    renderComposerTag={renderComposerTag}
                    renderComposerTagTooltip={renderComposerTagTooltip}
                    onComposerTagClick={onComposerTagClick}
                    preserveCustomKindLabel={part.preserveCustomKindLabel}
                  />
                ),
              )}
              {preview.truncated ? '...' : null}
              {fileCount > 0
                ? ` ${t('queue.fileCount', { count: fileCount })}`
                : ''}
              {isAdmissionUnknown && !hasUnknownPayload
                ? ` ${t('queue.localCopyDiscarded')}`
                : ''}
            </span>
            {imageCount > 0 ? (
              <span
                className={styles.queuedPromptImages}
                aria-label={t('queue.imageCount', { count: imageCount })}
                title={t('queue.imageCount', { count: imageCount })}
              >
                {safeImages.map(({ index, src }) => {
                  const alt = t('user.uploadedImage', { index: index + 1 });
                  return (
                    <img
                      key={index}
                      className={`${styles.queuedPromptImage}${
                        onImagePreview
                          ? ` ${styles.queuedPromptImageInteractive}`
                          : ''
                      }`}
                      src={src}
                      alt={alt}
                      role={onImagePreview ? 'button' : undefined}
                      tabIndex={onImagePreview ? 0 : undefined}
                      onClick={
                        onImagePreview
                          ? () => onImagePreview(src, alt)
                          : undefined
                      }
                      onKeyDown={
                        onImagePreview
                          ? (event) => {
                              if (event.key !== 'Enter' && event.key !== ' ')
                                return;
                              event.preventDefault();
                              onImagePreview(src, alt);
                            }
                          : undefined
                      }
                    />
                  );
                })}
              </span>
            ) : null}
            {isSubmitting ||
            isQueued ||
            isMidTurnPending ||
            isAdmissionUnknown ||
            prompt.isEditing ||
            isRemoving ? (
              <span
                className={`${styles.queuedPromptState}${
                  hasStateSpinner ? ` ${styles.queuedPromptStateLoading}` : ''
                }`}
                role="status"
              >
                {hasStateSpinner && (
                  <span className={styles.queuedPromptSpinner} />
                )}
                <span className={styles.queuedPromptStateLabel}>
                  {isRemoving
                    ? t('queue.removing')
                    : prompt.isEditing
                      ? t('queue.editing')
                      : isMidTurnPending
                        ? t('queue.midTurnQueued')
                        : isAdmissionUnknown
                          ? t('queue.admissionUnknown')
                          : isQueued
                            ? t('queue.serverQueued')
                            : t('queue.submitting')}
                </span>
              </span>
            ) : null}
            <span className={styles.queuedPromptActions}>
              {hasUnknownPayload ? (
                <>
                  <button
                    type="button"
                    className={styles.queuedPromptAction}
                    onClick={() => {
                      if (window.confirm(t('queue.continueEditingConfirm'))) {
                        onRestoreUnknown?.(prompt.id);
                      }
                    }}
                    aria-label={t('queue.restoreUnknown')}
                    title={t('queue.restoreUnknown')}
                  >
                    {t('queue.restoreUnknown')}
                  </button>
                  <button
                    type="button"
                    className={styles.queuedPromptAction}
                    onClick={() => onDiscardUnknown?.(prompt.id)}
                    aria-label={t('queue.discardUnknown')}
                    title={t('queue.discardUnknown')}
                  >
                    {t('queue.discardUnknown')}
                  </button>
                </>
              ) : showActions && !isAdmissionUnknown ? (
                <>
                  <button
                    type="button"
                    className={styles.queuedPromptAction}
                    onClick={() => onDelete(prompt.id)}
                    disabled={isBusy}
                    aria-label={t('queue.delete')}
                    title={deleteTitle}
                  >
                    <span
                      className={styles.queuedPromptActionIcon}
                      style={cssUrlVar('--queued-icon-url', deleteIconUrl)}
                      aria-hidden="true"
                    />
                  </button>
                  <button
                    type="button"
                    className={styles.queuedPromptAction}
                    onClick={() => onEdit(prompt.id)}
                    disabled={isEditDisabled}
                    aria-label={t('queue.edit')}
                    title={editTitle}
                  >
                    <span
                      className={styles.queuedPromptActionIcon}
                      style={cssUrlVar('--queued-icon-url', editIconUrl)}
                      aria-hidden="true"
                    />
                  </button>
                </>
              ) : null}
            </span>
          </div>
        );
      })}
      {showQueueShortcuts ? (
        <div className={styles.queuedHint}>{t('queue.footer')}</div>
      ) : null}
    </div>
  );
}
