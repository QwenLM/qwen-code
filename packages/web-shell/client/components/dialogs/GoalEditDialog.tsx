import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import styles from './GoalsDialog.module.css';

interface GoalEditDialogProps {
  objective: string;
  saving: boolean;
  error?: string | null;
  onSave: (objective: string) => void;
  onClose: () => void;
}

export function GoalEditDialog({
  objective,
  saving,
  error,
  onSave,
  onClose,
}: GoalEditDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(objective);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => setValue(objective), [objective]);

  const submit = () => {
    if (saving) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setLocalError(t('goals.error.emptyCondition'));
      return;
    }
    setLocalError(null);
    onSave(trimmed);
  };

  const close = () => {
    if (!saving) onClose();
  };

  return (
    <DialogShell title={t('goals.edit')} size="md" onClose={close}>
      <div className={styles.formFields}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('goals.objective')}</span>
          <textarea
            className={styles.textarea}
            value={value}
            rows={4}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {(localError || error) && (
          <div className={styles.formError} role="alert">
            {localError || error}
          </div>
        )}
        <div className={styles.formActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={close}
            disabled={saving}
          >
            {t('goals.cancel')}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={submit}
            disabled={saving}
          >
            {saving ? t('goals.saving') : t('goals.save')}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
