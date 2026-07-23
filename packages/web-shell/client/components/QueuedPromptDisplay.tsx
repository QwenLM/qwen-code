/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptImage } from '../adapters/promptTypes';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import { Fragment } from 'react';
import deleteIconUrl from '../assets/icons/delete.svg';
import editIconUrl from '../assets/icons/edit.svg';
import insertIconUrl from '../assets/icons/insert.svg';
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
  isEditing?: boolean;
  isRemoving?: boolean;
}

export function QueuedPromptDisplay({
  prompts,
  t,
  onDelete,
  onInsert,
  onEdit,
}: {
  prompts: readonly QueuedPrompt[];
  t: ReturnType<typeof getTranslator>;
  onDelete: (id: number) => void;
  onInsert: (id: number) => void;
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
        const isRunning = prompt.serverState === 'running';
        const isRemoving = prompt.isRemoving === true;
        const isBusy =
          isSubmitting || isRunning || prompt.isEditing === true || isRemoving;
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
              {isSubmitting || prompt.isEditing || isRemoving ? (
                <span className={styles.queuedPromptState}>
                  <span className={styles.queuedPromptSpinner} />
                  {isRemoving
                    ? t('queue.removing')
                    : prompt.isEditing
                      ? t('queue.editing')
                      : t('queue.submitting')}
                </span>
              ) : null}
            </span>
            <span className={styles.queuedPromptActions}>
              {imageCount === 0 && (
                <button
                  type="button"
                  className={styles.queuedPromptAction}
                  onClick={() => onInsert(prompt.id)}
                  disabled={isCommand || isBusy}
                  title={insertTitle}
                >
                  <span
                    className={styles.queuedPromptActionIcon}
                    style={cssUrlVar('--queued-icon-url', insertIconUrl)}
                    aria-hidden="true"
                  />
                  {t('queue.insert')}
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
          </div>
        );
      })}
      <div className={styles.queuedHint}>{t('queue.footer')}</div>
    </div>
  );
}
