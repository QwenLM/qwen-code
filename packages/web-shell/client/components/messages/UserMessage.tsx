import { memo } from 'react';
import { PromptChevron } from '../PromptChevron';
import { isSafeImageSrc } from './Markdown';
import { useI18n } from '../../i18n';
import type { TurnCollapseHead } from '../../adapters/types';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
  /** When set, renders a toggle that folds/unfolds this turn's steps. */
  collapse?: TurnCollapseHead;
  onToggleCollapse?: (turnId: string) => void;
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
  collapse,
  onToggleCollapse,
}: UserMessageProps) {
  const { t } = useI18n();
  return (
    <div className={styles.message}>
      <span className={styles.prefix}>
        <PromptChevron />
      </span>
      <div className={styles.body}>
        {images && images.length > 0 && (
          <div className={styles.images}>
            {images.map((img, index) => {
              const src = img.data.startsWith('data:')
                ? img.data
                : `data:${img.mimeType};base64,${img.data}`;
              if (!isSafeImageSrc(src)) return null;
              return (
                <img
                  key={index}
                  src={src}
                  alt={`User uploaded image ${index + 1}`}
                  className={styles.imageThumb}
                />
              );
            })}
          </div>
        )}
        {content}
      </div>
      {collapse && onToggleCollapse && (
        <button
          type="button"
          className={styles.collapseToggle}
          onClick={() => onToggleCollapse(collapse.turnId)}
          aria-expanded={!collapse.collapsed}
          aria-label={
            collapse.collapsed ? t('turn.expand') : t('turn.collapse')
          }
          title={collapse.collapsed ? t('turn.expand') : t('turn.collapse')}
        >
          {collapse.collapsed
            ? `⌄ ${t('turn.hiddenSteps', { count: collapse.hiddenCount })}`
            : '⌃'}
        </button>
      )}
    </div>
  );
});
