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
  // Normalize the persisted value on open — trim, drop blanks/dupes, and apply
  // max — so a hand-edited or oversized setting doesn't open as N/max and get
  // written back verbatim.
  const [selected, setSelected] = useState<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of current) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= max) break;
    }
    return out;
  });

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
    // No data-keyboard-scope here: the wrapping DialogShell already provides the
    // keyboard scope + role="dialog". A second scope on this inner div becomes
    // the last [data-keyboard-scope] match in DialogShell's close cleanup, whose
    // role="dialog" lookup then fails (it's the parent <section>), dropping focus
    // when this dialog closes while another DialogShell is stacked.
    <div className={styles.body}>
      <div className={styles.hint}>
        {t('settings.models.fallbacks.hint', { max })}
      </div>
      <div
        className={styles.list}
        role="group"
        aria-label={t('settings.models.fallbacks.title')}
      >
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
              // aria-disabled (not the native `disabled`) so the button still
              // receives hover/focus and can surface the "limit reached" title —
              // disabled buttons fire no events, so the tooltip never shows. The
              // toggle() handler already no-ops when at the max.
              aria-disabled={atLimit || undefined}
              title={
                atLimit
                  ? t('settings.models.fallbacks.limitReached', { max })
                  : undefined
              }
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
