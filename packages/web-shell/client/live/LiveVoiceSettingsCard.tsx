/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { FlaskConicalIcon } from 'lucide-react';
import type { DaemonLiveRequirementState } from '@qwen-code/sdk';
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
import { Separator } from '../components/ui/separator';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { HotkeySetter } from './HotkeySetter';
import type { UseLiveVoiceSetupResult } from './useLiveVoiceSetup';

const INSTALLING_STATES = new Set([
  'checking',
  'downloading',
  'verifying',
  'installing',
  'launching',
]);

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
  const [apiKey, setApiKey] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = setup.status;
  const enabled = status?.enabled === true;
  const busy = setup.mutating || setup.loading;
  const installBusy = INSTALLING_STATES.has(status?.install.state ?? '');
  const requirements = status?.live.requirements;

  const saveKey = async () => {
    const value = apiKey.trim();
    if (!value) return;
    try {
      await setup.update({
        apiKey: { operation: 'replace', value },
      });
      setApiKey('');
    } catch {
      // The hook exposes the sanitized daemon error in the card.
    }
  };

  const clearKey = async () => {
    try {
      await setup.update({ apiKey: { operation: 'clear' } });
      setApiKey('');
    } catch {
      // The hook exposes the sanitized daemon error in the card.
    }
  };

  const setEnabled = async (next: boolean) => {
    if (next) {
      setConfirmOpen(true);
      return;
    }
    try {
      await setup.update({ enabled: false });
    } catch {
      // The hook exposes the sanitized daemon error in the card.
    }
  };

  const confirmEnable = () => {
    void setup.update({ enabled: true }).catch(() => undefined);
  };

  const launchOrRetry = () => {
    const operation =
      status?.install.state === 'error'
        ? setup.retryInstall()
        : setup.launchHost();
    void operation.catch(() => undefined);
  };

  return (
    <div className="space-y-5 p-5 max-md:p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t('settings.liveSetup.title')}</span>
            <Badge variant="outline">
              {t('settings.liveSetup.experimental')}
            </Badge>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {t('settings.liveSetup.description')}
          </p>
        </div>
        {setup.loading && !status ? (
          <Spinner />
        ) : (
          <Switch
            checked={enabled}
            disabled={busy || (!enabled && status?.keyConfigured !== true)}
            aria-label={t('settings.liveSetup.enable')}
            onCheckedChange={(next) => void setEnabled(next)}
          />
        )}
      </div>

      <Separator />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="live-realtime-key" className="text-sm font-medium">
              {t('settings.liveSetup.apiKey')}
            </label>
            <div className="flex items-center gap-1">
              <Badge variant={status?.keyConfigured ? 'secondary' : 'outline'}>
                {t(
                  status?.keyConfigured
                    ? 'settings.liveSetup.configured'
                    : 'settings.liveSetup.notConfigured',
                )}
              </Badge>
              {status?.keyConfigured && !enabled ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={setup.mutating}
                  onClick={() => void clearKey()}
                >
                  {t('settings.liveSetup.removeKey')}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              id="live-realtime-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={setup.mutating}
              placeholder={
                status?.keyConfigured
                  ? t('settings.liveSetup.apiKeyReplace')
                  : t('settings.liveSetup.apiKeyPlaceholder')
              }
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveKey();
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!apiKey.trim() || setup.mutating}
              onClick={() => void saveKey()}
            >
              {setup.mutating ? <Spinner /> : t('settings.liveSetup.save')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {status?.model ?? 'qwen3.5-omni-plus-realtime'}
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">
            {t('settings.liveSetup.shortcut')}
          </div>
          <HotkeySetter
            accelerator={status?.shortcut ?? 'Command+E'}
            disabled={setup.mutating}
            captureLabel={t('settings.liveShortcut.capture')}
            clearLabel={t('settings.liveShortcut.clear')}
            offLabel={t('settings.liveShortcut.off')}
            onChange={async (shortcut) => setup.update({ shortcut })}
          />
        </div>
      </div>

      {enabled && status ? (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
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
                  size="sm"
                  variant="outline"
                  disabled={setup.mutating}
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

      {(setup.error || (enabled && status?.install.message)) && (
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
            <AlertDialogAction onClick={confirmEnable}>
              {t('settings.liveSetup.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
