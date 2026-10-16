/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConicalIcon } from 'lucide-react';
import type {
  DaemonLiveRequirementState,
  DaemonLiveSetupUpdate,
} from '@qwen-code/sdk';
import { useI18n } from '../i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Separator } from '../components/ui/separator';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { HotkeySetter } from './HotkeySetter';
import { liveModelOptions } from './live-model-options';
import {
  INSTALLING_STATES,
  type UseLiveVoiceSetupResult,
} from './useLiveVoiceSetup';

// The Select value for "type another id". Stored model ids are trimmed, so
// none can start with a space.
const CUSTOM_MODEL = ' custom';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

function RequirementBadge({
  state,
}: {
  state: DaemonLiveRequirementState | undefined;
}) {
  const { t } = useI18n();
  const effective = state ?? 'checking';
  return (
    <Badge
      variant={
        effective === 'ready'
          ? 'secondary'
          : effective === 'denied' || effective === 'unavailable'
            ? 'destructive'
            : 'outline'
      }
    >
      {t(`settings.liveSetup.requirement.${effective}`)}
    </Badge>
  );
}

export function LiveVoiceSettingsCard({
  setup,
}: {
  setup: UseLiveVoiceSetupResult;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<DaemonLiveSetupUpdate>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [saving, setSaving] = useState(false);
  const status = setup.status;
  const draftBaseline = useRef(new Map<keyof DaemonLiveSetupUpdate, unknown>());
  const savedEnabled = status?.enabled === true;
  const enabled = draft.enabled ?? savedEnabled;
  const busy = saving || setup.mutating || (setup.loading && !status);
  const installBusy =
    status !== undefined && INSTALLING_STATES.has(status.install.state);
  const requirements = status?.live.requirements;
  const savedModel = status?.model ?? '';
  const model = draft.model ?? savedModel;
  const modelChanged = model.trim() !== savedModel;
  // Older daemons omit these fields and refuse updates to them.
  const modelChoices =
    status?.models !== undefined ? liveModelOptions(status) : undefined;
  const candidateModel =
    status && liveModelOptions({ ...status, model: model.trim() });
  const keyFromRoute = modelChanged
    ? candidateModel?.options.find(
        (option) => option.value === candidateModel.selected,
      )?.route === true
    : status?.keySource === 'route';
  const modelError = !modelChanged && status?.modelError;
  const keyEditable = status !== undefined && !keyFromRoute && !modelError;
  const savedEndpoint = status?.endpoint;
  const endpointDraft =
    draft.endpoint ??
    (status?.keySource === 'route' && !keyFromRoute
      ? ''
      : (savedEndpoint ?? ''));
  const savedVoice = status?.voice ?? '';
  const voice = draft.voice ?? savedVoice;
  const voiceEditable = status?.voice !== undefined && !modelError;
  const apiKey =
    draft.apiKey?.operation === 'replace' ? draft.apiKey.value : '';
  const keyCleared = draft.apiKey?.operation === 'clear';
  const keyRequired =
    keyEditable &&
    (!status?.keyConfigured ||
      keyCleared ||
      (status.keySource === 'route' && status.storedKey !== true));
  const nativeHost = status?.nativeHost !== false;
  const shortcut = draft.shortcut ?? status?.shortcut ?? 'Command+E';

  const savedValue = useCallback(
    (key: keyof DaemonLiveSetupUpdate) =>
      key === 'apiKey'
        ? JSON.stringify([
            status?.keyConfigured,
            status?.keySource,
            status?.storedKey,
            status?.keyEnv,
          ])
        : key === 'endpoint'
          ? JSON.stringify([status?.keySource, savedEndpoint])
          : status?.[key],
    [savedEndpoint, status],
  );
  const stage = <K extends keyof DaemonLiveSetupUpdate>(
    key: K,
    value: DaemonLiveSetupUpdate[K],
  ) => {
    if (draft[key] === undefined)
      draftBaseline.current.set(key, savedValue(key));
    // Route status does not expose the saved independent endpoint. An
    // explicitly cleared endpoint must still be sent when leaving a route.
    const settles =
      value === undefined ||
      (key !== 'apiKey' &&
        !(key === 'endpoint' && status?.keySource === 'route') &&
        value === (key === 'endpoint' ? savedEndpoint : savedValue(key)));
    // The edit settled back onto the saved value: forget the baseline so a
    // later refresh cannot compare against a value the user never saw.
    if (settles) draftBaseline.current.delete(key);
    setDraft((current) => {
      const next = { ...current, [key]: value };
      if (settles) delete next[key];
      return next;
    });
  };

  // A draft field the latest status now saves verbatim is settled — drop it
  // and its conflict baseline. Otherwise the stale baseline survives a
  // refresh that converged onto the staged value, and the next edit of that
  // field is blocked by a conflict the user never saw. Draft-only re-renders
  // must not settle: a padded draft that trims onto the saved value is still
  // being typed into, so only a genuine status change may converge it — and
  // the daemon SDK returns a fresh object per fetch, so "genuine" means a
  // changed saved value, not a changed object identity; a 1s install poll
  // returning unchanged data must not converge a draft mid-typing either.
  const lastSettleStatus = useRef<UseLiveVoiceSetupResult['status']>(undefined);
  // A rejected save may still have landed partially on the daemon: its
  // settings writes persist before setEnabled is attempted, and only
  // `enabled` is rolled back when that call fails. The NEXT status refresh
  // must re-baseline the keys that request carried, or the card's own write
  // is reported back as a settings.liveSetup.conflict — and since the settle
  // effect below never converges the apiKey baseline, Save would stay
  // blocked until the whole typed draft is discarded. Held in state (not a
  // ref) so the re-baseline provokes the render that clears the conflict.
  const [rebaselineAfterFailedSave, setRebaselineAfterFailedSave] = useState<{
    keys: Set<keyof DaemonLiveSetupUpdate>;
    at: UseLiveVoiceSetupResult['status'];
  } | null>(null);
  useEffect(() => {
    const previous = lastSettleStatus.current;
    lastSettleStatus.current = status;
    if (!status) return;
    const valueChanged =
      previous === undefined
        ? true
        : previous === status
          ? false
          : (
              ['enabled', 'model', 'voice', 'endpoint', 'shortcut'] as const
            ).some((key) => previous[key] !== status[key]);
    if (!valueChanged) return;
    const settled = (
      ['enabled', 'model', 'voice', 'endpoint', 'shortcut'] as const
    ).filter((key) => {
      const draftValue = draft[key];
      if (draftValue === undefined) return false;
      if (key === 'endpoint' && status.keySource === 'route') return false;
      // Submit paths trim text fields, so a refresh that converges on the
      // trimmed form of a padded draft has still converged on the saved value.
      if (key === 'model' || key === 'voice' || key === 'endpoint') {
        return (
          typeof draftValue === 'string' && draftValue.trim() === status[key]
        );
      }
      return draftValue === status[key];
    });
    if (settled.length === 0) return;
    for (const key of settled) draftBaseline.current.delete(key);
    setDraft((current) => {
      const next = { ...current };
      for (const key of settled) delete next[key];
      return next;
    });
  }, [status, draft]);

  // Runs only once a refresh actually lands a new status identity after a
  // failed save — never against the pre-refresh values.
  useEffect(() => {
    if (rebaselineAfterFailedSave === null) return;
    if (!status || status === rebaselineAfterFailedSave.at) return;
    for (const key of rebaselineAfterFailedSave.keys)
      draftBaseline.current.set(key, savedValue(key));
    setRebaselineAfterFailedSave(null);
  }, [rebaselineAfterFailedSave, savedValue, status]);

  useEffect(() => {
    if (!status) {
      setDraft({});
      setCustomModel(false);
      setConfirmOpen(false);
      setRebaselineAfterFailedSave(null);
    }
  }, [status]);

  const update: DaemonLiveSetupUpdate = {};
  if (enabled !== savedEnabled) update.enabled = enabled;
  if (modelChoices && modelChanged) update.model = model.trim();
  if (voiceEditable && voice.trim() !== savedVoice) update.voice = voice.trim();
  if (
    savedEndpoint !== undefined &&
    keyEditable &&
    draft.endpoint !== undefined &&
    // Route status exposes its URL, not the saved independent endpoint.
    (endpointDraft.trim() !== savedEndpoint || status?.keySource === 'route')
  ) {
    update.endpoint = endpointDraft.trim();
  }
  if (keyCleared) update.apiKey = { operation: 'clear' };
  else if (keyEditable && apiKey.trim()) {
    update.apiKey = { operation: 'replace', value: apiKey.trim() };
  }
  if (
    nativeHost &&
    draft.shortcut !== undefined &&
    shortcut !== status?.shortcut
  )
    update.shortcut = shortcut;
  const dirty = Object.keys(update).length > 0;
  const invalid = update.model === '' || update.voice === '';
  // Keys queued for a failed-save re-baseline cannot conflict yet: their
  // baseline predates a write the card itself made, and the refresh that
  // re-anchors them is the one that failed save just triggered.
  const conflict = (
    Object.keys(update) as Array<keyof DaemonLiveSetupUpdate>
  ).some(
    (key) =>
      !rebaselineAfterFailedSave?.keys.has(key) &&
      draftBaseline.current.get(key) !== savedValue(key),
  );

  // Validate the entire candidate configuration in one daemon request; retain
  // the draft on failure so a rejected field can be corrected and retried.
  const save = async () => {
    if (busy || !status || !dirty || invalid || conflict) return;
    setSaving(true);
    try {
      await setup.update(update);
      setDraft({});
      setCustomModel(false);
    } catch {
      // The hook exposes the sanitized daemon error in the card. The daemon
      // applies a request's writes before setEnabled and rolls back only
      // `enabled` when that fails, so part of this save may have landed:
      // queue a re-baseline of the keys it carried, then refresh — the card's
      // own write must never be the elsewhere a conflict is reported against.
      setRebaselineAfterFailedSave({
        keys: new Set(
          Object.keys(update) as Array<keyof DaemonLiveSetupUpdate>,
        ),
        at: status,
      });
      await setup.refresh();
    } finally {
      setSaving(false);
    }
  };
  const requestSave = () => {
    if (busy || !status || !dirty || invalid || conflict) return;
    if (enabled && !savedEnabled && nativeHost) setConfirmOpen(true);
    else void save();
  };
  const chooseModel = (value: string) => {
    setCustomModel(value === CUSTOM_MODEL);
    if (value !== CUSTOM_MODEL) {
      stage('model', value);
    }
  };

  const launchOrRetry = () => {
    const operation =
      status?.install.state === 'error'
        ? setup.retryInstall()
        : setup.launchHost();
    void operation.catch(() => undefined);
  };

  return (
    <div className="w-full max-w-3xl space-y-6 p-5 max-md:p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('settings.liveSetup.title')}</span>
            <Badge variant="outline">
              {t('settings.liveSetup.experimental')}
            </Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t(
              nativeHost
                ? 'settings.liveSetup.description'
                : 'settings.liveSetup.browserDescription',
            )}
          </p>
        </div>
        {setup.loading && !status ? (
          <Spinner />
        ) : (
          <Switch
            checked={enabled}
            disabled={busy || !status}
            aria-label={t('settings.liveSetup.enable')}
            onCheckedChange={(enabled) => stage('enabled', enabled)}
          />
        )}
      </div>

      <Separator />

      <div className="grid gap-6">
        {savedEndpoint !== undefined ? (
          <div className="space-y-2" data-live-endpoint>
            <label
              htmlFor="live-realtime-endpoint"
              className="block text-sm font-medium"
            >
              {t('settings.liveSetup.endpoint')}
            </label>
            {keyFromRoute ? (
              <>
                <p className="break-all text-sm" id="live-realtime-endpoint">
                  {modelChanged ? null : savedEndpoint}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('settings.liveSetup.endpointFromRoute')}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    id="live-realtime-endpoint"
                    autoComplete="off"
                    value={endpointDraft}
                    disabled={busy || !keyEditable}
                    placeholder={
                      status?.keySource === 'route' &&
                      draft.endpoint === undefined
                        ? t('settings.liveSetup.endpointUnchanged')
                        : DEFAULT_BASE_URL
                    }
                    onChange={(event) => stage('endpoint', event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') requestSave();
                    }}
                  />
                </div>
                {status?.endpointError ? (
                  <p
                    className="text-xs text-destructive"
                    role="alert"
                    data-live-endpoint-error
                  >
                    {status.endpointError}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {t('settings.liveSetup.endpointHint')}
                </p>
              </>
            )}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="flex min-h-6 items-center justify-between gap-3">
            <label
              htmlFor="live-realtime-key"
              className="block text-sm font-medium"
            >
              {t('settings.liveSetup.apiKey')}
              {keyRequired && (
                <span className="ml-1 text-destructive" aria-hidden="true">
                  *
                </span>
              )}
            </label>
            <div className="flex items-center gap-1">
              {status?.keyConfigured && !keyCleared && !modelChanged && (
                <span className="text-xs text-muted-foreground">
                  {t('settings.liveSetup.configured')}
                </span>
              )}
              {keyCleared ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t('settings.liveSetup.keyRemovalPending')}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => stage('apiKey', undefined)}
                  >
                    {t('settings.liveSetup.undoRemoveKey')}
                  </Button>
                </>
              ) : !enabled &&
                (status?.storedKey === true ||
                  (status?.keyConfigured === true &&
                    status?.keySource !== 'route')) ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || keyCleared}
                  onClick={() => stage('apiKey', { operation: 'clear' })}
                >
                  {t('settings.liveSetup.removeKey')}
                </Button>
              ) : null}
            </div>
          </div>
          {keyFromRoute ? (
            modelChanged ? (
              <p className="text-xs text-muted-foreground" data-live-key-route>
                {t('settings.liveSetup.keyFromModel')}
              </p>
            ) : status?.keyError ? (
              <p
                className="text-xs text-destructive"
                role="alert"
                data-live-key-error
              >
                {status.keyError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground" data-live-key-route>
                {t(
                  status?.keyConfigured
                    ? 'settings.liveSetup.keyFromEnv'
                    : 'settings.liveSetup.keyFromEnvMissing',
                  { env: status?.keyEnv ?? '' },
                )}
              </p>
            )
          ) : keyEditable ? (
            <div className="flex items-center gap-2">
              <Input
                id="live-realtime-key"
                aria-required={keyRequired}
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={busy}
                placeholder={
                  status?.keyConfigured && !keyCleared
                    ? t('settings.liveSetup.apiKeyReplace')
                    : t('settings.liveSetup.apiKeyPlaceholder')
                }
                onChange={(event) =>
                  stage(
                    'apiKey',
                    event.target.value
                      ? { operation: 'replace', value: event.target.value }
                      : undefined,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') requestSave();
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="live-realtime-model"
            className="block text-sm font-medium"
          >
            {t('settings.liveSetup.model')}
          </label>
          {modelChoices ? (
            <Select
              value={
                customModel
                  ? CUSTOM_MODEL
                  : (draft.model ?? modelChoices.selected)
              }
              disabled={busy}
              onValueChange={chooseModel}
            >
              <SelectTrigger id="live-realtime-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelChoices.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_MODEL}>
                  {t('settings.liveSetup.modelCustom')}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm" id="live-realtime-model">
              {status?.model ?? 'qwen3.5-omni-plus-realtime'}
            </p>
          )}
          {customModel ? (
            <div className="flex items-center gap-2">
              <Input
                autoComplete="off"
                aria-label={t('settings.liveSetup.model')}
                data-live-model-input
                value={model}
                disabled={busy}
                onChange={(event) => stage('model', event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') requestSave();
                }}
              />
            </div>
          ) : null}
          {modelError ? (
            <p className="text-xs text-destructive" role="alert">
              {modelError}
            </p>
          ) : null}
          {modelChoices ? (
            <p className="text-xs text-muted-foreground">
              {t('settings.liveSetup.modelHint')}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t('settings.liveSetup.appliesNextCall')}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="live-realtime-voice"
            className="block text-sm font-medium"
          >
            {t('settings.liveSetup.voice')}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="live-realtime-voice"
              autoComplete="off"
              value={voice}
              disabled={busy || !voiceEditable}
              onChange={(event) => stage('voice', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') requestSave();
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('settings.liveSetup.voiceHint')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('settings.liveSetup.appliesNextCall')}
          </p>
        </div>

        <div className="space-y-2" hidden={!nativeHost}>
          <div className="block text-sm font-medium">
            {t('settings.liveSetup.shortcut')}
          </div>
          <HotkeySetter
            accelerator={shortcut}
            disabled={busy || !status}
            captureLabel={t('settings.liveShortcut.capture')}
            clearLabel={t('settings.liveShortcut.clear')}
            offLabel={t('settings.liveShortcut.off')}
            onChange={async (shortcut) => stage('shortcut', shortcut)}
          />
        </div>
      </div>

      {conflict && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{t('settings.liveSetup.conflict')}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft({});
              setCustomModel(false);
              setConfirmOpen(false);
            }}
          >
            {t('settings.liveSetup.reloadSettings')}
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          data-live-settings-save
          className="transition-none"
          disabled={busy || !status || !dirty || invalid || conflict}
          onClick={requestSave}
        >
          {saving || setup.mutating ? <Spinner /> : null}
          {t('settings.liveSetup.save')}
        </Button>
      </div>

      {savedEnabled && status && nativeHost ? (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="block text-sm font-medium">
                  {t('settings.liveSetup.host')}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(`settings.liveSetup.install.${status.install.state}`)}
                  {status.install.version ? ` · ${status.install.version}` : ''}
                </div>
              </div>
              {installBusy ? (
                <Spinner />
              ) : status.install.state === 'error' ||
                (status.install.state === 'installed' &&
                  requirements?.host !== 'ready') ? (
                <Button
                  type="button"
                  size="default"
                  variant="outline"
                  disabled={busy}
                  onClick={launchOrRetry}
                >
                  {status.install.state === 'error'
                    ? t('settings.liveSetup.retry')
                    : t('settings.liveSetup.openHost')}
                </Button>
              ) : (
                <RequirementBadge state={requirements?.host} />
              )}
            </div>
            {typeof status.install.progress === 'number' && installBusy ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.round(status.install.progress * 100)}%`,
                  }}
                />
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  ['microphone', requirements?.microphone],
                  ['accessibility', requirements?.accessibility],
                  ['screenRecording', requirements?.screenRecording],
                ] as const
              ).map(([name, state]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <span className="text-xs">
                    {t(`settings.liveSetup.permission.${name}`)}
                  </span>
                  <RequirementBadge state={state} />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.liveSetup.permissionHint')}
            </p>
          </div>
        </>
      ) : null}

      {(setup.error ||
        (savedEnabled && nativeHost && status?.install.message)) && (
        <p className="text-sm text-destructive" role="alert">
          {setup.error?.message ?? status?.install.message}
        </p>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <FlaskConicalIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('settings.liveSetup.confirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.liveSetup.confirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('settings.liveSetup.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void save()}>
              {t('settings.liveSetup.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
