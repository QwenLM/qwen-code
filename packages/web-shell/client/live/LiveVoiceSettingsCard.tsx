/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
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
    (!status?.keyConfigured || keyCleared || status.keySource === 'route');
  const nativeHost = status?.nativeHost !== false;
  const shortcut = draft.shortcut ?? status?.shortcut ?? 'Command+E';

  useEffect(() => {
    if (!status) {
      setDraft({});
      setCustomModel(false);
      setConfirmOpen(false);
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

  // Validate the entire candidate configuration in one daemon request; retain
  // the draft on failure so a rejected field can be corrected and retried.
  const save = async () => {
    if (busy || !status || !dirty || invalid) return;
    setSaving(true);
    try {
      await setup.update(update);
      setDraft({});
      setCustomModel(false);
    } catch {
      // The hook exposes the sanitized daemon error in the card.
    } finally {
      setSaving(false);
    }
  };
  const requestSave = () => {
    if (busy || !status || !dirty || invalid) return;
    if (enabled && !savedEnabled && nativeHost) setConfirmOpen(true);
    else void save();
  };
  const chooseModel = (value: string) => {
    setCustomModel(value === CUSTOM_MODEL);
    if (value !== CUSTOM_MODEL) {
      setDraft((current) => ({ ...current, model: value }));
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
            onCheckedChange={(enabled) =>
              setDraft((current) => ({ ...current, enabled }))
            }
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
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        endpoint: event.target.value,
                      }))
                    }
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
              {!enabled &&
              (status?.storedKey === true ||
                (status?.keyConfigured === true && !keyFromRoute)) ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy || keyCleared}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      apiKey: { operation: 'clear' },
                    }))
                  }
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
                  setDraft((current) => ({
                    ...current,
                    apiKey: { operation: 'replace', value: event.target.value },
                  }))
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
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    model: event.target.value,
                  }))
                }
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
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  voice: event.target.value,
                }))
              }
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
            disabled={busy}
            captureLabel={t('settings.liveShortcut.capture')}
            clearLabel={t('settings.liveShortcut.clear')}
            offLabel={t('settings.liveShortcut.off')}
            onChange={async (shortcut) =>
              setDraft((current) => ({ ...current, shortcut }))
            }
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          data-live-settings-save
          className="transition-none"
          disabled={busy || !status || !dirty || invalid}
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
