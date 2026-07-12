/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptImage } from '../adapters/promptTypes';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import deleteIconUrl from '../assets/icons/delete.svg';
import editIconUrl from '../assets/icons/edit.svg';
import insertIconUrl from '../assets/icons/insert.svg';
import queueIconUrl from '../assets/icons/queue.svg';
import type { getTranslator } from '../i18n';
import { cssUrlVar } from '../utils/cssUrlVar';
import { isCommandPrompt } from '../utils/localCommandQueue';
import styles from '../App.module.css';

const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 240;

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
  if (prompts.length === 0) return null;

  return (
    <div className={styles.queuedPrompts}>
      {prompts.map((prompt) => {
        const normalizedPreview = prompt.text.replace(/\s+/g, ' ').trim();
        const preview =
          normalizedPreview.length > MAX_QUEUED_PROMPT_PREVIEW_CHARS
            ? `${normalizedPreview.slice(0, MAX_QUEUED_PROMPT_PREVIEW_CHARS)}...`
            : normalizedPreview;
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
              {preview}
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
