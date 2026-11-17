import { LinkIcon } from 'lucide-react';
import type { WebShellSource } from '../../customization';
import { useI18n } from '../../i18n';
import { FileTypeIcon } from '../FileTypeIcon';
import { sourceKey, sourceLocation, sourceTitle } from './sourceEntries';
import styles from '../panels/EnvironmentPanel.module.css';

export function SourceList({
  entries,
  onOpen,
}: {
  entries: readonly WebShellSource[];
  onOpen?: (entry: WebShellSource) => void;
}) {
  const { t } = useI18n();
  return (
    <ul className={styles.attachmentFiles}>
      {entries.map((entry) => (
        <li key={sourceKey(entry)}>
          <button
            type="button"
            className={styles.attachmentFile}
            title={sourceLocation(entry)}
            aria-label={
              entry.type === 'source'
                ? `${t('sources.open')} ${sourceTitle(entry)}`
                : undefined
            }
            disabled={!onOpen}
            onClick={() => onOpen?.(entry)}
          >
            {entry.type === 'source' && entry.source.kind === 'link' ? (
              <LinkIcon
                size={16}
                strokeWidth={1.7}
                className={styles.attachmentFileIcon}
              />
            ) : (
              <FileTypeIcon
                name={sourceLocation(entry)}
                mimeType={
                  entry.type === 'attachment'
                    ? entry.attachment.mimeType
                    : undefined
                }
                size={16}
                strokeWidth={1.7}
                className={styles.attachmentFileIcon}
                aria-hidden="true"
              />
            )}
            <span className={styles.attachmentFileName}>
              {sourceTitle(entry)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
