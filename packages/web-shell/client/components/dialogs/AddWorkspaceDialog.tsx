import { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { dp } from './dialogStyles';
import { DialogShell } from './DialogShell';
import styles from './AddWorkspaceDialog.module.css';

interface AddWorkspaceDialogProps {
  onClose: () => void;
  onAdd: (cwd: string) => Promise<void>;
}

export function AddWorkspaceDialog({
  onClose,
  onAdd,
}: AddWorkspaceDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = path.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\//]/.test(trimmed)) {
        setError(t('sidebar.addWorkspaceAbsError'));
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        await onAdd(trimmed);
        onClose();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('sidebar.addWorkspaceError'),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [path, onAdd, onClose, t],
  );

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      size="sm"
      onClose={onClose}
    >
      <form className={dp('dialog-form')} onSubmit={handleSubmit}>
        <div className={dp('dialog-form-row')}>
          <label className={styles.label} htmlFor="add-workspace-path">
            {t('sidebar.addWorkspacePath')}
          </label>
          <input
            ref={inputRef}
            id="add-workspace-path"
            type="text"
            className={styles.input}
            placeholder="/absolute/path/to/project"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            disabled={submitting}
          />
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <div className={dp('dialog-footer-actions')}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={onClose}
            disabled={submitting}
          >
            {t('sidebar.addWorkspaceCancel')}
          </button>
          <button
            type="submit"
            className={dp('dialog-primary-button')}
            disabled={submitting || !path.trim()}
          >
            {submitting ? '...' : t('sidebar.addWorkspaceRegister')}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
