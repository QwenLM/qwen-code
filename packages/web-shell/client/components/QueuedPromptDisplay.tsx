import type { PromptImage } from '../adapters/promptTypes';
import { getTranslator } from '../i18n';
import { isCommandPrompt } from '../utils/localCommandQueue';
import { cssUrlVar } from '../utils/cssUrlVar';
import deleteIconUrl from '../assets/icons/delete.svg';
import editIconUrl from '../assets/icons/edit.svg';
import insertIconUrl from '../assets/icons/insert.svg';
import queueIconUrl from '../assets/icons/queue.svg';
import styles from './QueuedPromptDisplay.module.css';

const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 240;

export interface QueuedPromptView {
  id: number;
  text: string;
  images?: PromptImage[];
}

interface QueuedPromptDisplayProps {
  prompts: readonly QueuedPromptView[];
  t: ReturnType<typeof getTranslator>;
  onDelete: (id: number) => void;
  onInsert: (id: number) => void;
  onEdit: (id: number) => void;
}

export function QueuedPromptDisplay({
  prompts,
  t,
  onDelete,
  onInsert,
  onEdit,
}: QueuedPromptDisplayProps) {
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
        // A command (/… or !…) can't be inserted into the running turn — insert
        // injects raw text the model would see literally, never running the
        // command. Show the action disabled so it stays visible but inert.
        const isCommand = isCommandPrompt(prompt.text);
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
            </span>
            <span className={styles.queuedPromptActions}>
              {imageCount === 0 && (
                <button
                  type="button"
                  className={styles.queuedPromptAction}
                  onClick={() => onInsert(prompt.id)}
                  disabled={isCommand}
                  title={
                    isCommand ? t('queue.insertCommandDisabled') : undefined
                  }
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
                aria-label={t('queue.delete')}
                title={t('queue.delete')}
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
                aria-label={t('queue.edit')}
                title={t('queue.edit')}
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
    </div>
  );
}
