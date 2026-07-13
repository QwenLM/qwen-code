import { useState } from 'react';
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
 * provider-qualified `modelId` match means a bare `currentModelId` (which can
 * equal several endpoint variants' `baseModelId`) marks only ONE row current
 * instead of every same-base-id variant. Falls back to the persisted `isCurrent`
 * flag when no live current id is available yet (the live id is updated
 * optimistically on select, so it's authoritative while present).
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
    const byBase = all.find(
      ({ model }) => model.baseModelId === currentModelId,
    );
    return byBase ? rowKeyFor(byBase.provider, byBase.model) : undefined;
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

      {providers.map((provider) =>
        provider.models.length === 0 ? null : (
          <div className={styles.provider} key={provider.authType}>
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
