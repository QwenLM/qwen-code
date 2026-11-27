/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useId, useMemo, useState } from 'react';
import {
  DaemonHttpError,
  type DaemonModelPreference,
  type DaemonModelPreferenceEffort,
  type DaemonModelPreferenceField,
  type DaemonModelPreferenceRow,
  type DaemonModelPreferenceScope,
  type DaemonModelPreferences,
  type DaemonModelPreferencesPatch,
  type DaemonClient,
} from '@qwen-code/sdk/daemon';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonWorkspaceEventSignals } from '../../daemon/session/DaemonSessionProvider';
import { useDaemonResource } from '../../daemon/workspace/hooks/useDaemonResource';
import { useWorkspaceEventReload } from '../../daemon/workspace/hooks/useWorkspaceEventReload';
import { useI18n } from '../../i18n';
import { isDiscontinuedSettingsModel } from '../../utils/composerModels';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Switch } from '../ui/switch';
import styles from './ModelPreferencesSection.module.css';

type DraftRow = {
  contextWindow?: string | null;
  enabled?: boolean | null;
  effort?: DaemonModelPreferenceEffort | null;
};
type ScopeDraft = Record<string, DraftRow & { modelName: string }>;

const FIELDS = {
  enabled: 'reasoning.thinking',
  effort: 'reasoning.effort',
  contextWindow: 'settings.modelPreferences.contextWindow',
} as const;

function fieldValue(
  value: DaemonModelPreference,
  field: DaemonModelPreferenceField,
) {
  return field === 'contextWindow'
    ? value.contextWindow
    : value.reasoning?.[field];
}

function isValidContextWindow(value: string, limit: number): boolean {
  const count = Number(value);
  return (
    /^\d+$/u.test(value.trim()) &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= limit
  );
}

export function WorkspaceModelPreferencesSection({
  workspaceCwd,
  scope,
}: {
  workspaceCwd: string;
  scope: DaemonModelPreferenceScope;
}) {
  const { client, baseUrl } = useWorkspace();
  return (
    <ScopedModelPreferencesSection
      key={`${baseUrl}:${workspaceCwd}`}
      client={client}
      workspaceCwd={workspaceCwd}
      scope={scope}
    />
  );
}

function ScopedModelPreferencesSection({
  client,
  workspaceCwd,
  scope,
}: {
  client: DaemonClient;
  workspaceCwd: string;
  scope: DaemonModelPreferenceScope;
}) {
  const target = useMemo(
    () => client.workspaceByCwd(workspaceCwd),
    [client, workspaceCwd],
  );
  const load = useCallback(() => target.modelPreferences(), [target]);
  const { data, loading, error, reload } = useDaemonResource(load, {
    autoLoad: true,
  });
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(signals?.settingsVersion, reload, true, true);

  return (
    <ModelPreferencesSection
      scope={scope}
      data={data}
      loading={loading}
      error={error}
      onReload={reload}
      onSave={async (patch) => {
        await target.updateModelPreferences(patch);
        await reload();
      }}
    />
  );
}

export function ModelPreferencesSection({
  scope,
  data,
  loading,
  error,
  onReload,
  onSave,
}: {
  scope: DaemonModelPreferenceScope;
  data?: DaemonModelPreferences;
  loading?: boolean;
  error?: Error;
  onReload?: () => void;
  onSave: (patch: DaemonModelPreferencesPatch) => Promise<void>;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<
    Partial<Record<DaemonModelPreferenceScope, ScopeDraft>>
  >({});
  const [feedback, setFeedback] = useState<
    Partial<
      Record<
        DaemonModelPreferenceScope,
        { saving?: boolean; error?: string; saved?: boolean }
      >
    >
  >({});
  const [staleData, setStaleData] = useState<DaemonModelPreferences>();
  const needsReload = staleData !== undefined && staleData === data;
  const draft = drafts[scope] ?? {};
  const entries = Object.entries(draft);
  const status = feedback[scope];
  const dirty = entries.length > 0;
  const writable = scope === 'user' || data?.workspaceWritable === true;
  const models = (data?.models ?? []).filter(
    (model) =>
      !isDiscontinuedSettingsModel(model, {
        baseModelId: model.modelId,
        isCurrent: model.isCurrent,
      }),
  );
  const byKey = new Map(models.map((model) => [model.key, model]));
  const unavailable = entries.filter(([key]) => !byKey.has(key));
  const nameCounts = new Map<string, number>();
  for (const { name } of models) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const valid = entries.every(([key, row]) => {
    const model = byKey.get(key);
    return (
      model &&
      (row.contextWindow == null ||
        isValidContextWindow(row.contextWindow, model.contextLimit))
    );
  });
  const canSave =
    dirty && valid && writable && !status?.saving && !loading && !needsReload;
  const setStatus = (next: typeof status) =>
    setFeedback((previous) => ({ ...previous, [scope]: next }));
  const clearDraft = () =>
    setDrafts((previous) => ({ ...previous, [scope]: undefined }));
  const edit = (
    { key, name, provider, authType }: DaemonModelPreferenceRow,
    value: DraftRow,
  ) => {
    setDrafts((previous) => ({
      ...previous,
      [scope]: {
        ...previous[scope],
        [key]: {
          ...previous[scope]?.[key],
          ...value,
          modelName: `${name} (${provider ?? authType})`,
        },
      },
    }));
    setStatus(undefined);
  };
  const discardUnavailable = (key: string) => {
    setDrafts((previous) => {
      const remaining = { ...previous[scope] };
      delete remaining[key];
      return { ...previous, [scope]: remaining };
    });
    setStatus(undefined);
  };
  const save = async () => {
    setStatus({ saving: true });
    try {
      await onSave({
        scope,
        changes: entries.map(([key, { contextWindow, enabled, effort }]) => ({
          key,
          ...(contextWindow !== undefined
            ? {
                contextWindow:
                  contextWindow === null ? null : Number(contextWindow),
              }
            : {}),
          ...(enabled !== undefined || effort !== undefined
            ? {
                reasoning: {
                  ...(enabled !== undefined ? { enabled } : {}),
                  ...(effort !== undefined ? { effort } : {}),
                },
              }
            : {}),
        })),
      });
      clearDraft();
      setStatus({ saved: true });
    } catch (cause) {
      if (cause instanceof DaemonHttpError && cause.status === 409) {
        setStaleData(data);
        setStatus(undefined);
        return;
      }
      setStatus({
        error:
          cause instanceof Error
            ? cause.message
            : t('settings.modelPreferences.saveFailed'),
      });
    }
  };

  return (
    <form
      className={styles.panel}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <h3 className={styles.title}>{t('settings.modelPreferences.title')}</h3>
      {(error || needsReload) && (
        <div className={styles.error}>
          <span role="alert">
            {error?.message ?? t('settings.modelPreferences.catalogChanged')}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onReload}
            disabled={loading}
          >
            {t(
              needsReload
                ? 'settings.modelPreferences.reload'
                : 'settings.modelPreferences.retry',
            )}
          </Button>
        </div>
      )}
      {!data && !error && <p role="status">{t('settings.models.loading')}</p>}
      {data && models.length === 0 && <p>{t('settings.models.empty')}</p>}
      {models.length > 0 && (
        <table
          className={styles.table}
          aria-label={t('settings.modelPreferences.title')}
        >
          <thead>
            <tr>
              <th scope="col">{t('settings.modelPreferences.name')}</th>
              <th scope="col">{t(FIELDS.enabled)}</th>
              <th scope="col">{t(FIELDS.effort)}</th>
              <th scope="col">{t(FIELDS.contextWindow)}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <ModelPreferenceRow
                key={model.key}
                model={model}
                showProvider={(nameCounts.get(model.name) ?? 0) > 1}
                scope={scope}
                draft={draft[model.key] ?? {}}
                readOnly={!writable || status?.saving === true}
                onEdit={(value) => edit(model, value)}
              />
            ))}
          </tbody>
        </table>
      )}
      {unavailable.map(([key, { modelName }]) => (
        <div key={key} className={styles.error}>
          <span role="alert">
            {t('settings.modelPreferences.unavailableModel', {
              model: modelName,
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${t('settings.modelPreferences.discardEdits')} · ${modelName}`}
            disabled={status?.saving}
            onClick={() => discardUnavailable(key)}
          >
            {t('settings.modelPreferences.discardEdits')}
          </Button>
        </div>
      ))}
      {status?.error && (
        <p className={styles.error} role="alert">
          {status.error}
        </p>
      )}
      {status?.saved && <p role="status">{t('settings.models.saved')}</p>}
      {data && (
        <footer className={styles.footer}>
          <p>{t('settings.modelPreferences.appliesNextTurn')}</p>
          <div className={styles.actions}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!dirty || status?.saving}
              onClick={() => {
                clearDraft();
                setStatus(undefined);
              }}
            >
              {t('settings.models.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSave}>
              {t('settings.modelPreferences.save')}
            </Button>
          </div>
        </footer>
      )}
    </form>
  );
}

function ModelPreferenceRow({
  model,
  showProvider,
  scope,
  draft,
  readOnly,
  onEdit,
}: {
  model: DaemonModelPreferenceRow;
  showProvider: boolean;
  scope: DaemonModelPreferenceScope;
  draft: DraftRow;
  readOnly: boolean;
  onEdit: (draft: DraftRow) => void;
}) {
  const { t, language } = useI18n();
  const limitId = useId();
  const scoped = model.values[scope];
  const inherited = model.values.inherited[scope];
  const effective =
    scope === 'user' ? model.values.userEffective : model.values.effective;
  const ownEffort =
    draft.effort === null
      ? undefined
      : (draft.effort ?? scoped.reasoning?.effort);
  const inheritedEnabled =
    scope === 'workspace' ? model.values.user.reasoning?.enabled : undefined;
  const enabled =
    model.reasoning?.canDisable === false ||
    (model.locked.includes('enabled') ||
    (draft.enabled === undefined && draft.effort === undefined)
      ? effective.reasoning?.enabled
      : ((draft.enabled === null
          ? inheritedEnabled
          : (draft.enabled ?? scoped.reasoning?.enabled ?? inheritedEnabled)) ??
        (ownEffort && model.reasoning?.effortEnablesThinking
          ? true
          : inherited.reasoning?.enabled)));
  const effort = model.locked.includes('effort')
    ? effective.reasoning?.effort
    : (ownEffort ?? inherited.reasoning?.effort);
  const inheritedWindow = inherited.contextWindow ?? model.contextLimit;
  const scopedWindow = scoped.contextWindow ?? inheritedWindow;
  const context = model.locked.includes('contextWindow')
    ? String(model.values.effective.contextWindow ?? model.contextLimit)
    : draft.contextWindow === null
      ? String(inheritedWindow)
      : (draft.contextWindow ??
        String(Math.min(scopedWindow, model.contextLimit)));
  const validContext = isValidContextWindow(context, model.contextLimit);
  const maxTokens = model.contextLimit.toLocaleString(language);
  const provider = showProvider ? (model.provider ?? model.authType) : null;
  const name = provider ? `${model.name} · ${provider}` : model.name;
  const label = (field: DaemonModelPreferenceField) =>
    `${name} · ${t(FIELDS[field])}`;
  const editable = (field: DaemonModelPreferenceField) =>
    !readOnly && !model.locked.includes(field);
  const fieldSource = (field: DaemonModelPreferenceField) => {
    const value = draft[field];
    const set =
      value !== undefined
        ? value !== null
        : fieldValue(scoped, field) !== undefined;
    const source = model.locked.includes(field)
      ? 'system'
      : set
        ? scope
        : model.inheritedSources[scope][field];
    return (
      <div className={styles.source}>
        <span>{t(`settings.modelPreferences.source.${source}`)}</span>
        {set && editable(field) && (
          <button
            type="button"
            className={styles.reset}
            aria-label={`${label(field)} · ${t('settings.modelPreferences.inherit')}`}
            onClick={() => onEdit({ [field]: null })}
          >
            {t('settings.modelPreferences.inherit')}
          </button>
        )}
      </div>
    );
  };
  return (
    <tr className={styles.modelRow}>
      <th scope="row">
        <span className={styles.name}>{model.name}</span>
        {provider && <span className={styles.provider}>{provider}</span>}
      </th>
      <td>
        <span className={styles.compactLabel} aria-hidden="true">
          {t(FIELDS.enabled)}
        </span>
        {!model.reasoning ? (
          '—'
        ) : !model.reasoning.canDisable ? (
          <span>{t('settings.modelPreferences.alwaysOn')}</span>
        ) : (
          <>
            <Switch
              className={styles.thinkingToggle}
              aria-label={label('enabled')}
              checked={enabled === true}
              disabled={
                !editable('enabled') ||
                (enabled !== true && !model.reasoning.canEnable)
              }
              onCheckedChange={(value) => onEdit({ enabled: value })}
            />
            {fieldSource('enabled')}
          </>
        )}
      </td>
      <td>
        <span className={styles.compactLabel} aria-hidden="true">
          {t(FIELDS.effort)}
        </span>
        {model.reasoning?.efforts.length ? (
          <>
            <Select
              value={effort ?? ''}
              disabled={!editable('effort') || enabled !== true}
              onValueChange={(value) =>
                onEdit({ effort: value as DaemonModelPreferenceEffort })
              }
            >
              <SelectTrigger
                className={styles.effort}
                aria-label={label('effort')}
                size="sm"
              >
                <SelectValue
                  placeholder={t('settings.modelPreferences.providerDefault')}
                />
              </SelectTrigger>
              <SelectContent>
                {model.reasoning.efforts.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`reasoning.effort.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldSource('effort')}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className={styles.contextCell}>
        <span className={styles.compactLabel} aria-hidden="true">
          {t(FIELDS.contextWindow)}
        </span>
        <div className={styles.contextControls}>
          <div className={styles.windowField}>
            <Input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              aria-label={label('contextWindow')}
              aria-invalid={!validContext}
              aria-describedby={
                validContext ? limitId : `${limitId} ${limitId}-error`
              }
              value={context}
              disabled={!editable('contextWindow')}
              onChange={(event) =>
                onEdit({ contextWindow: event.currentTarget.value })
              }
            />
            <span className={styles.windowUnit} aria-hidden="true">
              {t('settings.modelPreferences.tokens')}
            </span>
          </div>
          <span id={limitId} className={styles.windowLimit}>
            {t('settings.modelPreferences.limit', { tokens: maxTokens })}
          </span>
        </div>
        {!validContext && (
          <div id={`${limitId}-error`} role="alert" className={styles.error}>
            {t('settings.modelPreferences.invalidWindow', {
              tokens: maxTokens,
            })}
          </div>
        )}
        {fieldSource('contextWindow')}
      </td>
    </tr>
  );
}
