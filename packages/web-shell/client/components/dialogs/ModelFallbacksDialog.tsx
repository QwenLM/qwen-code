import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import styles from './ModelFallbacksDialog.module.css';

export interface FallbackModelOption {
  /** Base model id persisted in the modelFallbacks setting. */
  baseId: string;
  label: string;
}

export interface ModelFallbacksDialogProps {
  models: FallbackModelOption[];
  /** Currently configured fallback base ids, in priority order. */
  current: string[];
  max: number;
  onConfirm: (baseIds: string[]) => void;
  onClose: () => void;
}

export function ModelFallbacksDialog({
  models,
  current,
  max,
  onConfirm,
  onClose,
}: ModelFallbacksDialogProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>(current);

  // Show the available models plus any already-configured fallback whose model
  // is no longer available, so the user can still see and remove it.
  const rows = useMemo(() => {
    const known = new Set(models.map((m) => m.baseId));
    const extra = selected
      .filter((id) => !known.has(id))
      .map((id) => ({ baseId: id, label: id }));
    return [...models, ...extra];
  }, [models, selected]);

  const toggle = (baseId: string) => {
    setSelected((prev) => {
      if (prev.includes(baseId)) return prev.filter((x) => x !== baseId);
      if (prev.length >= max) return prev;
      return [...prev, baseId];
    });
  };

  return (
    <div className={styles.body} data-keyboard-scope>
      <div className={styles.hint}>
        {t('settings.models.fallbacks.hint', { max })}
      </div>
      <div className={styles.list}>
        {rows.length === 0 && (
          <div className={styles.empty}>
            {t('settings.models.fallbacks.empty')}
          </div>
        )}
        {rows.map((model) => {
          const order = selected.indexOf(model.baseId);
          const isSelected = order >= 0;
          const atLimit = selected.length >= max && !isSelected;
          return (
            <button
              key={model.baseId}
              type="button"
              aria-pressed={isSelected}
              className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
              disabled={atLimit}
              onClick={() => toggle(model.baseId)}
            >
              <span className={styles.badge}>
                {isSelected ? order + 1 : ''}
              </span>
              <span className={styles.label}>{model.label}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.footer}>
        <span className={styles.count}>
          {selected.length}/{max}
        </span>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>
            {t('settings.models.cancel')}
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={() => onConfirm(selected)}
          >
            {t('settings.models.fallbacks.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
