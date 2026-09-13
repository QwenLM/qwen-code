import { useEffect, useId, useState } from 'react';
import type {
  DaemonModelConfiguration,
  DaemonModelConfigurationUpdateResult,
} from '@qwen-code/sdk/daemon';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Field, FieldLabel, FieldDescription } from '../ui/field';
import type {
  DaemonWorkspaceProviderModel,
  DaemonWorkspaceProviderStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import styles from './ModelManagementSection.module.css';

export interface ModelDeleteTarget {
  key?: string;
  authType: string;
  modelId: string;
  baseUrl?: string;
}

export interface ModelManagementProps {
  providers: DaemonWorkspaceProviderStatus[];
  configurations?: DaemonModelConfiguration[];
  onUpdateContextWindow?: (
    key: string,
    size: number | null,
  ) => Promise<DaemonModelConfigurationUpdateResult>;
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
  configurations = [],
  onUpdateContextWindow,
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

  const displayProviders = providers.map((provider) => ({
    ...provider,
    models: [...provider.models],
  }));
  const uniqueConfigurations = [
    ...new Map(configurations.map((config) => [config.key, config])).values(),
  ];
  const missing = uniqueConfigurations.filter(
    (config) =>
      !providers.some((provider) =>
        provider.models.some((model) => model.configurationKey === config.key),
      ),
  );
  for (const config of missing) {
    let provider = displayProviders.find(
      (item) => item.authType === config.authType,
    );
    if (!provider) {
      provider = {
        kind: 'model_provider',
        status: 'ok',
        authType: config.authType,
        current: false,
        models: [],
      };
      displayProviders.push(provider);
    }
    provider.models.push({
      configurationKey: config.key,
      modelId: config.key,
      baseModelId: config.modelId,
      name: config.name || config.modelId,
      baseUrl: config.baseUrl,
      envKey: config.envKey,
      contextLimit: config.contextWindowSize,
      isCurrent: false,
      isRuntime: false,
    });
  }
  const hasModels = displayProviders.some((p) => p.models.length > 0);
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

      {displayProviders.map((provider, providerIndex) =>
        provider.models.length === 0 ? null : (
          // Include the index: two providers can share an authType (e.g. two
          // OpenAI-compatible endpoints), which would collide on authType alone.
          <div
            className={styles.provider}
            key={`${provider.authType}:${providerIndex}`}
          >
            <div className={styles.providerName}>{provider.authType}</div>
            {provider.models.map((model) => {
              const candidates = configurations.filter(
                (config) => config.key === model.configurationKey,
              );
              const configuration =
                candidates.length === 1 ? candidates[0] : undefined;
              const canSelect = providers.some((source) =>
                source.models.includes(model),
              );
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
                    {!canSelect && (
                      <span className={styles.runtimeBadge}>
                        {t('settings.models.savedConfiguration')}
                      </span>
                    )}
                    {model.name && model.name !== model.baseModelId && (
                      <span className={styles.modelId}>
                        {model.baseModelId}
                      </span>
                    )}
                    {model.description && (
                      <div className={styles.modelDescription}>
                        {model.description}
                      </div>
                    )}
                    {model.baseUrl && (
                      <span className={styles.modelBaseUrl}>
                        {model.baseUrl.split(/[?#]/)[0]}
                      </span>
                    )}
                    {(model.contextLimit ||
                      model.modalities ||
                      model.envKey) && (
                      <div className={styles.modelDetails}>
                        {model.contextLimit !== undefined &&
                          model.contextLimit > 0 && (
                            <span>
                              {t('settings.models.context', {
                                tokens: model.contextLimit.toLocaleString(),
                              })}
                            </span>
                          )}
                        {(
                          [
                            ['image', 'auth.advanced.modalityImage'],
                            ['video', 'auth.advanced.modalityVideo'],
                            ['audio', 'auth.advanced.modalityAudio'],
                            ['pdf', 'auth.advanced.modalityPdf'],
                          ] as const
                        ).map(([key, label]) =>
                          model.modalities?.[key] ? (
                            <span className={styles.capability} key={key}>
                              {t(label)}
                            </span>
                          ) : null,
                        )}
                        {model.envKey && (
                          <span>
                            {t('settings.models.credentialEnv')}:{' '}
                            <code>{model.envKey}</code>
                          </span>
                        )}
                      </div>
                    )}
                    {configuration && (
                      <>
                        {configuration.purpose !== 'chat' && (
                          <span className={styles.capability}>
                            {t(`auth.purpose.${configuration.purpose}`)}
                          </span>
                        )}
                        {configuration.canEditContextWindow === false && (
                          <div className={styles.modelDescription}>
                            {t('settings.models.ambiguousWindow')}
                          </div>
                        )}
                        {onUpdateContextWindow &&
                          configuration.canEditContextWindow !== false && (
                            <ModelWindowEditor
                              configuration={configuration}
                              busy={busy}
                              onSave={onUpdateContextWindow}
                            />
                          )}
                      </>
                    )}
                  </div>
                  <div className={styles.modelActions}>
                    {!current && canSelect && (
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
                                ...(model.configurationKey
                                  ? { key: model.configurationKey }
                                  : {}),
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

function ModelWindowEditor({
  configuration,
  busy,
  onSave,
}: {
  configuration: DaemonModelConfiguration;
  busy: boolean;
  onSave: NonNullable<ModelManagementProps['onUpdateContextWindow']>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const valid =
    !value.trim() ||
    (/^\d+$/.test(value.trim()) &&
      Number(value) >= 1 &&
      Number(value) <= 10_000_000);
  if (!editing)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`${t('settings.models.editWindow')} ${configuration.name || configuration.modelId}`}
          onClick={() => {
            setValue(configuration.contextWindowSize?.toString() ?? '');
            setError('');
            setNotice('');
            setEditing(true);
          }}
        >
          {t('settings.models.editWindow')}
        </Button>
        {notice && (
          <span role="status" className="text-xs text-muted-foreground">
            {notice}
          </span>
        )}
      </div>
    );
  return (
    <form
      className="mt-3 flex max-w-md flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || saving || busy) return;
        setSaving(true);
        setError('');
        onSave(configuration.key, value.trim() ? Number(value) : null)
          .then((result) => {
            setEditing(false);
            setNotice(
              result.runtimeSync?.status === 'failed'
                ? t('settings.models.runtimeSyncFailed')
                : result.requiresRestart
                  ? t('settings.models.windowSaved')
                  : t('settings.models.saved'),
            );
          })
          .catch((err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
          )
          .finally(() => setSaving(false));
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>{t('auth.advanced.contextWindow')}</FieldLabel>
        <Input
          id={id}
          value={value}
          inputMode="numeric"
          placeholder={t('common.auto')}
          disabled={saving || busy}
          aria-invalid={!valid}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setValue(event.target.value)}
        />
        <FieldDescription id={`${id}-hint`}>
          {valid
            ? t('settings.models.windowHint')
            : t('auth.advanced.tokenLimitInvalid', {
                field: t('auth.advanced.contextWindow'),
              })}
        </FieldDescription>
      </Field>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          aria-label={`${t('common.save')} ${configuration.name || configuration.modelId}`}
          disabled={!valid || saving || busy}
        >
          {t('common.save')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving || busy}
          aria-label={`${t('settings.models.cancel')} ${configuration.name || configuration.modelId}`}
          onClick={() => setEditing(false)}
        >
          {t('settings.models.cancel')}
        </Button>
      </div>
    </form>
  );
}
