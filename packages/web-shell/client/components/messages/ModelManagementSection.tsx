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

function isCurrentModel(
  model: DaemonWorkspaceProviderModel,
  currentModelId: string | undefined,
): boolean {
  // The live current id (updated optimistically on select) is authoritative so
  // switching models doesn't briefly show two "current" badges; fall back to
  // the persisted `isCurrent` only when no live id is available yet.
  if (currentModelId) {
    return (
      currentModelId === model.modelId || currentModelId === model.baseModelId
    );
  }
  return model.isCurrent;
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

  return (
    <div className={styles.section} data-testid="model-management">
      <div className={styles.header}>
        <span className={styles.title}>{t('settings.models.title')}</span>
        <button type="button" className={styles.addButton} onClick={onAddModel}>
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
              const current = isCurrentModel(model, currentModelId);
              const rowKey = `${provider.authType}:${model.modelId}:${
                model.baseUrl ?? ''
              }`;
              const confirming = confirmKey === rowKey;
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
