import { useState, useCallback, useRef, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { dp } from './dialogStyles';
import { DialogShell } from './DialogShell';
import styles from './AddWorkspaceDialog.module.css';

interface AddWorkspaceDialogProps {
  onClose: () => void;
  onAdd: (cwd: string) => Promise<void>;
}

const HINT_ID = 'add-workspace-hint';
const ERROR_ID = 'add-workspace-error';

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
      size="md"
      onClose={onClose}
    >
      <form className={dp('dialog-form')} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label htmlFor="add-workspace-path">
            {t('sidebar.addWorkspacePath')}
          </label>
          <input
            ref={inputRef}
            id="add-workspace-path"
            type="text"
            placeholder="/absolute/path/to/project"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              if (error) setError(null);
            }}
            disabled={submitting}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={error ? `${ERROR_ID} ${HINT_ID}` : HINT_ID}
            aria-invalid={error ? true : undefined}
          />
          <span className={styles.hint} id={HINT_ID}>
            {t('sidebar.addWorkspaceHint')}
          </span>
          {error && (
            <span className={styles.error} id={ERROR_ID} role="alert">
              {error}
            </span>
          )}
        </div>
        <div
          className={dp('dialog-footer-actions')}
          style={{ paddingLeft: 0, paddingRight: 0 }}
        >
          <button
            type="button"
            className={dp('dialog-inline-button')}
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
            {submitting
              ? t('sidebar.addWorkspaceAdding')
              : t('sidebar.addWorkspaceRegister')}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
