import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonAvailability } from '../daemon/availability-context.js';
import { createDaemonRestRequest } from '../daemon/rest-request.js';
import { useI18n } from '../i18n';
import { writeClipboardText } from '../utils/clipboard';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Spinner } from './ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

interface RemoteAccessStatus {
  active: boolean;
  canManage: boolean;
  externallyConfigured: boolean;
  defaultPort?: number;
  interfaces?: Array<{ address: string; interfaceName: string }>;
  url?: string;
  address?: string;
  port?: number;
  generation?: string;
  encrypted?: boolean;
  origins?: string[];
  token?: string;
}

export function RemoteAccessSettingsCard() {
  const { baseUrl, token, client } = useWorkspace();
  const available = useDaemonAvailability() === 'available';
  const { t } = useI18n();
  const [status, setStatus] = useState<RemoteAccessStatus>();
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('');
  const [origins, setOrigins] = useState('');
  const [secret, setSecret] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef<RemoteAccessStatus | undefined>(undefined);
  const pending = useRef(false);
  const epoch = useRef(0);
  const revision = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const unavailable = useRef(t('remoteAccess.unavailable'));
  unavailable.current = t('remoteAccess.unavailable');

  const accept = (next: RemoteAccessStatus) => {
    const previous = current.current;
    if (previous?.generation !== next.generation || !next.active) {
      setSecret('');
      setRevealed(false);
    }
    if (!previous || previous.generation !== next.generation) {
      setOrigins((next.origins ?? []).join('\n'));
    } else if (
      JSON.stringify(previous.origins) !== JSON.stringify(next.origins)
    ) {
      setOrigins((draft) =>
        draft === (previous.origins ?? []).join('\n')
          ? (next.origins ?? []).join('\n')
          : draft,
      );
    }
    if (next.token) setSecret(next.token);
    setAddress((selected) => {
      if (next.active && next.address) return next.address;
      const choices = next.interfaces ?? [];
      if (choices.some((entry) => entry.address === selected)) return selected;
      return choices.length === 1 ? choices[0]!.address : '';
    });
    current.current = next;
    setStatus(next);
  };

  const request = async (action?: string, body?: object) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const timer = window.setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await createDaemonRestRequest(
        baseUrl,
        token,
        client,
      )(`/remote-access${action ? `/${action}` : ''}`, {
        method: action ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: abort.signal,
      });
      if (response.status === 404) throw new Error(unavailable.current);
      const result = (await response.json()) as RemoteAccessStatus & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error || `HTTP ${response.status}`);
      if (
        typeof result.active !== 'boolean' ||
        typeof result.canManage !== 'boolean'
      ) {
        throw new Error(unavailable.current);
      }
      return result;
    } finally {
      window.clearTimeout(timer);
    }
  };
  const requestRef = useRef(request);
  requestRef.current = request;
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  useEffect(() => {
    const generation = ++epoch.current;
    current.current = undefined;
    setStatus(undefined);
    setSecret('');
    setRevealed(false);
    setError('');
    setNotice('');
    setPort('');
    setAddress('');
    setBusy(false);
    pending.current = false;
    if (!available) return;
    let loading = false;
    const refresh = async () => {
      if (loading || pending.current || document.hidden) return;
      loading = true;
      const observedRevision = revision.current;
      try {
        const next = await requestRef.current();
        if (
          epoch.current !== generation ||
          pending.current ||
          revision.current !== observedRevision
        )
          return;
        acceptRef.current(next);
      } catch (failure) {
        if (
          epoch.current === generation &&
          !pending.current &&
          revision.current === observedRevision
        ) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      epoch.current = generation + 1;
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [available, baseUrl, token, client]);

  const perform = async (action: string, body?: object) => {
    if (pending.current || !available) return undefined;
    const generation = epoch.current;
    pending.current = true;
    ++revision.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await request(action, body);
      if (epoch.current !== generation) return undefined;
      accept(next);
      return next;
    } catch (failure) {
      if (epoch.current !== generation) return undefined;
      const message =
        failure instanceof Error ? failure.message : String(failure);
      // A lost response does not mean the server rolled the operation back.
      try {
        const next = await request();
        if (epoch.current === generation) accept(next);
      } catch {
        /* The next status refresh can reconcile the server state. */
      }
      if (epoch.current === generation) setError(message);
      return undefined;
    } finally {
      if (epoch.current === generation) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const copy = async (value: string) => {
    try {
      await writeClipboardText(value);
      setNotice(t('remoteAccess.copied'));
    } catch {
      setError(t('remoteAccess.copyFailed'));
    }
  };
  const configuredOrigins = () =>
    origins
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  const canManage =
    available && status?.canManage && !status.externallyConfigured;

  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-labelledby="remote-access-title"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label id="remote-access-title" htmlFor="remote-access-toggle">
            {t('remoteAccess.title')}
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('remoteAccess.description')}
          </p>
        </div>
        {busy && <Spinner />}
        {!status?.externallyConfigured && (
          <Switch
            id="remote-access-toggle"
            checked={status?.active ?? false}
            disabled={!canManage || busy || (!status?.active && !address)}
            onCheckedChange={(enabled) =>
              void perform(
                enabled ? 'enable' : 'disable',
                enabled
                  ? {
                      address,
                      port: port.trim() ? Number(port) : undefined,
                      origins: configuredOrigins(),
                    }
                  : undefined,
              )
            }
          />
        )}
      </div>
      <p className="break-all text-sm text-muted-foreground">
        {t('remoteAccess.server')}: {baseUrl}
      </p>
      <p className="text-sm" role="status">
        {!available
          ? t('daemon.connection.unavailable')
          : !status
            ? t('remoteAccess.loading')
            : status.externallyConfigured
              ? t('remoteAccess.external')
              : status.active
                ? t('remoteAccess.on')
                : t('remoteAccess.off')}
      </p>
      {status && !status.canManage && !status.externallyConfigured && (
        <p className="text-sm text-muted-foreground">
          {t('remoteAccess.localOnly')}
        </p>
      )}
      {canManage &&
        !status?.active &&
        (status?.interfaces?.length ?? 0) !== 1 && (
          <Select value={address} onValueChange={setAddress} disabled={busy}>
            <SelectTrigger aria-label={t('remoteAccess.network')}>
              <SelectValue placeholder={t('remoteAccess.network')} />
            </SelectTrigger>
            <SelectContent>
              {status?.interfaces?.map((entry) => (
                <SelectItem
                  key={`${entry.interfaceName}:${entry.address}`}
                  value={entry.address}
                >
                  {entry.interfaceName} · {entry.address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      {canManage && !status?.active && status?.interfaces?.length === 0 && (
        <p className="text-sm">{t('remoteAccess.noNetwork')}</p>
      )}
      {canManage && !status?.active && address && (
        <p className="text-sm">
          {t('remoteAccess.network')}: {address}
        </p>
      )}
      {canManage && status?.active && status.url && (
        <div className="flex flex-col gap-2">
          <Label>{t('remoteAccess.address')}</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={status.url}
              aria-label={t('remoteAccess.address')}
            />
            <Button variant="outline" onClick={() => void copy(status.url!)}>
              {t('common.copy')}
            </Button>
          </div>
          <Label htmlFor="remote-access-token">Bearer token</Label>
          <Input
            id="remote-access-token"
            readOnly
            autoComplete="off"
            type={revealed ? 'text' : 'password'}
            value={secret || '••••••••••••'}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (revealed) {
                  setRevealed(false);
                  return;
                }
                if (secret || (await perform('reveal'))) setRevealed(true);
              }}
            >
              {t(revealed ? 'remoteAccess.hide' : 'remoteAccess.reveal')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                const value = secret || (await perform('reveal'))?.token;
                if (value) await copy(value);
              }}
            >
              {t('remoteAccess.copyToken')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRevealed(false);
                void perform('reset-token');
              }}
            >
              {t('remoteAccess.reset')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('remoteAccess.resetHint')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              status.encrypted ? 'remoteAccess.encrypted' : 'remoteAccess.http',
            )}
          </p>
        </div>
      )}
      {canManage && (
        <details>
          <summary className="cursor-pointer text-sm">
            {t('remoteAccess.advanced')}
          </summary>
          <div className="mt-3 flex flex-col gap-2">
            {!status?.active && (
              <>
                <Label htmlFor="remote-access-port">
                  {t('remoteAccess.port')}
                </Label>
                <Input
                  id="remote-access-port"
                  inputMode="numeric"
                  type="number"
                  min={0}
                  max={65535}
                  disabled={busy}
                  placeholder={String(status?.defaultPort ?? '')}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
              </>
            )}
            <Label htmlFor="remote-access-origins">
              {t('remoteAccess.origins')}
            </Label>
            <textarea
              id="remote-access-origins"
              className="min-h-20 rounded-md border border-input bg-transparent p-2 text-sm"
              disabled={busy}
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t('remoteAccess.originsHint')}
            </p>
            {status?.active && (
              <Button
                className="w-fit"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform('origins', { origins: configuredOrigins() })
                }
              >
                {t('remoteAccess.apply')}
              </Button>
            )}
          </div>
        </details>
      )}
      {notice && (
        <p className="text-sm" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
