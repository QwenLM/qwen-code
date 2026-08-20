import { useEffect, useState } from 'react';
import type {
  DaemonWorkspaceProviderModel,
  DaemonWorkspaceProviderStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './ModelManagementSection.module.css';

export interface ModelDeleteTarget {
  authType: string;
  modelId: string;
  baseUrl?: string;
}

export interface ModelManagementProps {
  providers: DaemonWorkspaceProviderStatus[];
  /** Effective current model id (ACP or base form), for the "current" badge. */
  currentModelId: string | undefined;
  loading: boolean;
  error: Error | undefined;
  /** True while a select/delete request is in flight. */
  busy: boolean;
  onSelectModel: (modelId: string) => void;
  onDeleteModel: (target: ModelDeleteTarget) => void;
  onAddModel: () => void;
}

function rowKeyFor(
  provider: DaemonWorkspaceProviderStatus,
  model: DaemonWorkspaceProviderModel,
): string {
  return `${provider.authType}:${model.modelId}:${model.baseUrl ?? ''}`;
}

/**
 * Resolves the single row that is "current", returning its row key. Preferring a
 * provider-qualified `modelId` match identifies an endpoint variant precisely.
 * A bare id is used only when it has one possible row; ambiguous ids defer to
 * the server's `isCurrent` flag instead of guessing the first endpoint.
 */
function findCurrentRowKey(
  providers: DaemonWorkspaceProviderStatus[],
  currentModelId: string | undefined,
): string | undefined {
  const all = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  if (currentModelId) {
    const exact = all.find(({ model }) => model.modelId === currentModelId);
    if (exact) return rowKeyFor(exact.provider, exact.model);
    const byBase = all.filter(
      ({ model }) => model.baseModelId === currentModelId,
    );
    if (byBase.length === 1) {
      return rowKeyFor(byBase[0]!.provider, byBase[0]!.model);
    }
  }
  const flagged = all.find(({ model }) => model.isCurrent);
  return flagged ? rowKeyFor(flagged.provider, flagged.model) : undefined;
}

export function ModelManagementSection({
  providers,
  currentModelId,
  loading,
  error,
  busy,
  onSelectModel,
  onDeleteModel,
  onAddModel,
}: ModelManagementProps) {
  const { t } = useI18n();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  // Escape dismisses the inline delete confirmation — the conventional gesture,
  // so keyboard users don't have to Tab to Cancel.
  useEffect(() => {
    if (confirmKey === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmKey]);

  const hasModels = providers.some((p) => p.models.length > 0);
  const currentRowKey = findCurrentRowKey(providers, currentModelId);

  return (
    <div className={styles.section} data-testid="model-management">
      <div className={styles.header}>
        <span className={styles.title}>{t('settings.models.title')}</span>
        <button
          type="button"
          className={styles.addButton}
          disabled={busy}
          onClick={onAddModel}
        >
          {t('settings.models.add')}
        </button>
      </div>

      {error && <div className={styles.hint}>{error.message}</div>}
      {loading && !hasModels && (
        <div className={styles.hint}>{t('settings.models.loading')}</div>
      )}
      {!loading && !hasModels && !error && (
        <div className={styles.empty}>{t('settings.models.empty')}</div>
      )}

      {providers.map((provider, providerIndex) =>
        provider.models.length === 0 ? null : (
          // Include the index: two providers can share an authType (e.g. two
          // OpenAI-compatible endpoints), which would collide on authType alone.
          <div
            className={styles.provider}
            key={`${provider.authType}:${providerIndex}`}
          >
            <div className={styles.providerName}>{provider.authType}</div>
            {provider.models.map((model) => {
              const rowKey = rowKeyFor(provider, model);
              const current = rowKey === currentRowKey;
              const confirming = confirmKey === rowKey;
              // Screen-reader label so identically-named row actions are
              // distinguishable by which model they target.
              const modelLabel = model.name || model.baseModelId;
              return (
                <div className={styles.modelRow} key={rowKey}>
                  <div className={styles.modelInfo}>
                    <span className={styles.modelName}>
                      {model.name || model.baseModelId}
                    </span>
                    {current && (
                      <span className={styles.currentBadge}>
                        {t('settings.models.current')}
                      </span>
                    )}
                    {model.isRuntime && (
                      <span className={styles.runtimeBadge}>
                        {t('settings.models.runtime')}
                      </span>
                    )}
                    {model.baseUrl && (
                      <span className={styles.modelBaseUrl}>
                        {model.baseUrl}
                      </span>
                    )}
                  </div>
                  <div className={styles.modelActions}>
                    {!current && (
                      <button
                        type="button"
                        className={styles.actionButton}
                        disabled={busy}
                        aria-label={`${t('settings.models.setCurrent')} ${modelLabel}`}
                        onClick={() => onSelectModel(model.modelId)}
                      >
                        {t('settings.models.setCurrent')}
                      </button>
                    )}
                    {!model.isRuntime &&
                      (confirming ? (
                        <>
                          <button
                            type="button"
                            className={styles.confirmButton}
                            disabled={busy}
                            aria-label={`${t('settings.models.confirmDelete')} ${modelLabel}`}
                            onClick={() => {
                              setConfirmKey(null);
                              onDeleteModel({
                                authType: provider.authType,
                                modelId: model.baseModelId,
                                ...(model.baseUrl
                                  ? { baseUrl: model.baseUrl }
                                  : {}),
                              });
                            }}
                          >
                            {t('settings.models.confirmDelete')}
                          </button>
                          <button
                            type="button"
                            className={styles.actionButton}
                            disabled={busy}
                            aria-label={`${t('settings.models.cancel')} ${modelLabel}`}
                            onClick={() => setConfirmKey(null)}
                          >
                            {t('settings.models.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={styles.deleteButton}
                          disabled={busy}
                          aria-label={`${t('settings.models.delete')} ${modelLabel}`}
                          onClick={() => setConfirmKey(rowKey)}
                        >
                          {t('settings.models.delete')}
                        </button>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}
