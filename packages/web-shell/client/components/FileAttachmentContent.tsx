import { FileTypeIcon } from './FileTypeIcon';
import styles from './FileAttachmentContent.module.css';

export function FileAttachmentContent({
  name,
  mimeType,
}: {
  name: string;
  mimeType?: string;
}) {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1];
  const type = extension?.toUpperCase() || mimeType || 'FILE';
  return (
    <>
      <span className={styles.icon}>
        <FileTypeIcon
          name={name}
          mimeType={mimeType}
          size={24}
          aria-hidden="true"
        />
      </span>
      <span className={styles.details}>
        <span className={styles.name} title={name}>
          {name}
        </span>
        <span className={styles.type} title={type}>
          {type}
        </span>
      </span>
    </>
  );
}
