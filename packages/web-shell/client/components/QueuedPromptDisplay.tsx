/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptImage } from '../adapters/promptTypes';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import { Fragment } from 'react';
import { CornerDownRightIcon, ZapIcon } from 'lucide-react';
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
import { isCommandPrompt } from '../utils/localCommandQueue';
import { ReadonlyComposerTag } from './messages/UserMessage';
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
  inputAnnotations?: DaemonInputAnnotation[];
  onComplete?: () => void;
  serverPromptId?: string;
  serverState?: 'submitting' | 'queued' | 'running';
  midTurnState?: 'submitting' | 'queued';
  midTurnImmediate?: boolean;
  isEditing?: boolean;
  isRemoving?: boolean;
}

export function QueuedPromptDisplay({
  prompts,
  t,
  onDelete,
  onInsert,
  onImmediateInsert,
  insertActionsEnabled,
  onEdit,
}: {
  prompts: readonly QueuedPrompt[];
  t: ReturnType<typeof getTranslator>;
  onDelete: (id: number) => void;
  onInsert: (id: number) => void;
  onImmediateInsert: (id: number) => void;
  insertActionsEnabled: boolean;
  onEdit: (id: number) => void;
}) {
  const {
    parseUserMessageContent,
    composerTagIcons,
    renderComposerTag,
    renderComposerTagTooltip,
    onComposerTagClick,
  } = useWebShellCustomization();
  if (prompts.length === 0) return null;
  return (
    <div className={styles.queuedPrompts}>
      {prompts.map((prompt) => {
        const preview = truncateQueuedPromptParts(
          getQueuedPromptParts(prompt, parseUserMessageContent),
        );
        const imageCount = prompt.images?.length ?? 0;
        const isCommand = isCommandPrompt(prompt.text);
        const isSubmitting = prompt.serverState === 'submitting';
        const isQueued = prompt.serverState === 'queued';
        const isRunning = prompt.serverState === 'running';
        const isMidTurnSubmitting = prompt.midTurnState === 'submitting';
        const isMidTurnQueued = prompt.midTurnState === 'queued';
        const isImmediateInsert = prompt.midTurnImmediate === true;
        const isRemoving = prompt.isRemoving === true;
        const hasStateSpinner =
          isSubmitting ||
          isMidTurnSubmitting ||
          prompt.isEditing === true ||
          isRemoving;
        const hasState = hasStateSpinner || isQueued || isMidTurnQueued;
        const isBusy =
          isSubmitting ||
          isRunning ||
          prompt.midTurnState !== undefined ||
          prompt.isEditing === true ||
          isRemoving;
        let insertTitle = t('queue.insertTip');
        if (isBusy) {
          insertTitle = t('queue.submittingDisabled');
        } else if (isCommand) {
          insertTitle = t('queue.insertCommandDisabled');
        }
        let editTitle = t('queue.editTip');
        if (isBusy) {
          editTitle = t('queue.submittingDisabled');
        }
        const deleteTitle = isBusy
          ? t('queue.submittingDisabled')
          : t('queue.deleteTip');
        let stateLabel = t('queue.submitting');
        if (isRemoving) {
          stateLabel = t('queue.removing');
        } else if (prompt.isEditing) {
          stateLabel = t('queue.editing');
        } else if (isMidTurnSubmitting) {
          stateLabel = t(
            isImmediateInsert
              ? 'queue.immediateInserting'
              : 'queue.midTurnSubmitting',
          );
        } else if (isMidTurnQueued) {
          stateLabel = t(
            isImmediateInsert
              ? 'queue.immediateWaiting'
              : 'queue.midTurnQueued',
          );
        } else if (isQueued) {
          stateLabel = t('queue.serverQueued');
        }
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
              {imageCount > 0
                ? ` ${t('queue.imageCount', { count: imageCount })}`
                : ''}
            </span>
            {hasState ? (
              <span
                className={`${styles.queuedPromptState}${
                  hasStateSpinner ? ` ${styles.queuedPromptStateLoading}` : ''
                }`}
                role="status"
                title={
                  isMidTurnQueued
                    ? t(
                        isImmediateInsert
                          ? 'queue.immediateInsertTip'
                          : 'queue.midTurnQueuedTip',
                      )
                    : undefined
                }
              >
                {hasStateSpinner && (
                  <span className={styles.queuedPromptSpinner} />
                )}
                <span className={styles.queuedPromptStateLabel}>
                  {stateLabel}
                </span>
              </span>
            ) : null}
            {prompt.midTurnState === undefined ? (
              <span className={styles.queuedPromptActions}>
                {insertActionsEnabled && imageCount === 0 && (
                  <button
                    type="button"
                    className={styles.queuedPromptAction}
                    onClick={() => onInsert(prompt.id)}
                    disabled={isCommand || isBusy}
                    aria-label={t('queue.insert')}
                    title={insertTitle}
                  >
                    <CornerDownRightIcon
                      className={styles.queuedPromptLucideIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.queuedPromptActionLabel}>
                      {t('queue.insert')}
                    </span>
                  </button>
                )}
                {insertActionsEnabled && imageCount === 0 && (
                  <button
                    type="button"
                    className={`${styles.queuedPromptAction} ${styles.queuedPromptImmediateAction}`}
                    onClick={() => onImmediateInsert(prompt.id)}
                    disabled={isCommand || isBusy}
                    aria-label={t('queue.immediateInsert')}
                    title={t('queue.immediateInsertTip')}
                  >
                    <ZapIcon
                      className={styles.queuedPromptLucideIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.queuedPromptActionLabel}>
                      {t('queue.immediateInsert')}
                    </span>
                  </button>
                )}
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
                  disabled={isBusy}
                  aria-label={t('queue.edit')}
                  title={editTitle}
                >
                  <span
                    className={styles.queuedPromptActionIcon}
                    style={cssUrlVar('--queued-icon-url', editIconUrl)}
                    aria-hidden="true"
                  />
                </button>
              </span>
            ) : null}
          </div>
        );
      })}
      <div className={styles.queuedHint}>{t('queue.footer')}</div>
    </div>
  );
}
