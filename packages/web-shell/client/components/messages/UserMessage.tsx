import { memo } from 'react';
import { PromptChevron } from '../PromptChevron';
import { isSafeImageSrc } from './Markdown';
import styles from './UserMessage.module.css';

interface UserMessageImage {
  data: string;
  mimeType: string;
}

interface UserMessageProps {
  content: string;
  images?: UserMessageImage[];
}

export const UserMessage = memo(function UserMessage({
  content,
  images,
}: UserMessageProps) {
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
    </div>
  );
});
