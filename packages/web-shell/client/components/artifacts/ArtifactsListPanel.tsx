import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { FileTypeIcon } from '../FileTypeIcon';
import { Skeleton } from '../ui/skeleton';
import { artifactDisplayName } from './artifactUtils';
import styles from './ArtifactsListPanel.module.css';

interface ArtifactsListPanelProps {
  artifacts: readonly DaemonSessionArtifact[];
  loading?: boolean;
  onOpenArtifact?: (artifactId: string) => void;
}

/**
 * Session artifact list shown as a right-panel tab. The list reads the live
 * `artifacts` prop rather than a tab payload, so the tab stays serializable and
 * never shows a stale snapshot.
 */
export function ArtifactsListPanel({
  artifacts,
  loading = false,
  onOpenArtifact,
}: ArtifactsListPanelProps) {
  const { t } = useI18n();

  if (loading) {
    return (
      <ul
        className={styles.files}
        data-testid="artifacts-list-skeleton"
        role="status"
        aria-label={t('common.loading')}
      >
        {[72, 88, 64].map((width) => (
          <li key={width} className={styles.file}>
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className="h-4" style={{ width: `${width}%` }} />
          </li>
        ))}
      </ul>
    );
  }

  if (artifacts.length === 0) {
    return (
      <p className={styles.emptyDescription} data-testid="artifacts-list-empty">
        {t('environment.artifactsEmpty')}
      </p>
    );
  }

  return (
    <ul className={styles.files} data-testid="artifacts-list">
      {artifacts.map((artifact) => {
        const displayName = artifactDisplayName(artifact);
        return (
          <li key={artifact.id}>
            <button
              type="button"
              className={styles.file}
              title={displayName}
              onClick={() => onOpenArtifact?.(artifact.id)}
            >
              <FileTypeIcon
                name={artifact.workspacePath ?? artifact.title}
                mimeType={artifact.mimeType}
                size={16}
                strokeWidth={1.7}
                className={styles.fileIcon}
                aria-hidden
              />
              <span className={styles.fileName}>{displayName}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}