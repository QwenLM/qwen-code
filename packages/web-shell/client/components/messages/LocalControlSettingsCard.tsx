import { useEffect, useState } from 'react';
import { CopyIcon, WifiIcon } from 'lucide-react';
import { getDaemonAuthHeaders, getDaemonBaseUrl } from '../../config/daemon';
import { useI18n } from '../../i18n';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Spinner } from '../ui/spinner';

interface LanCandidate {
  interfaceName: string;
  address: string;
}

interface LocalControlStatus {
  active: boolean;
  url?: string;
  qrText?: string;
  interfaceName?: string;
  address?: string;
  sleepInhibited?: boolean;
  encrypted?: boolean;
  interfaces: LanCandidate[];
}

async function requestLocalControl(
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<LocalControlStatus> {
  const baseUrl = getDaemonBaseUrl() || window.location.origin;
  const headers = new Headers(getDaemonAuthHeaders());
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = (await response.json()) as LocalControlStatus & {
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

export function LocalControlSettingsCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<LocalControlStatus>();
  const [selectedAddress, setSelectedAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    requestLocalControl('GET', '/workspace/local-control')
      .then((next) => {
        setStatus(next);
        if (next.interfaces.length === 1) {
          setSelectedAddress(next.interfaces[0]!.address);
        }
      })
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  }, []);

  const toggle = async () => {
    if (!status) return;
    setBusy(true);
    setError('');
    try {
      const path = status.active
        ? '/workspace/local-control/disable'
        : '/workspace/local-control/enable';
      const body = status.active
        ? undefined
        : {
            address: selectedAddress || undefined,
            target: `${window.location.pathname}${window.location.search}`,
          };
      setStatus(await requestLocalControl('POST', path, body));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const needsSelection = (status?.interfaces.length ?? 0) > 1;

  return (
    <div className="flex flex-col gap-4 px-5 py-4 max-md:px-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            <WifiIcon className="size-4" aria-hidden="true" />
            {t('settings.localControl.title')}
            <Badge variant={status?.active ? 'default' : 'secondary'}>
              {status?.active
                ? t('settings.localControl.on')
                : t('settings.localControl.off')}
            </Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('settings.localControl.description')}
          </p>
        </div>
        {!status && !error && <Spinner />}
      </div>

      {!status?.active && needsSelection && (
        <Select value={selectedAddress} onValueChange={setSelectedAddress}>
          <SelectTrigger
            className="w-full max-w-sm"
            aria-label={t('settings.localControl.network')}
          >
            <SelectValue
              placeholder={t('settings.localControl.selectNetwork')}
            />
          </SelectTrigger>
          <SelectContent>
            {status?.interfaces.map((network) => (
              <SelectItem key={network.address} value={network.address}>
                {network.interfaceName} · {network.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {status?.active && status.url && (
        <div className="flex flex-wrap items-center gap-4">
          {status.qrText && (
            <pre
              aria-label={t('settings.localControl.qr')}
              className="w-fit overflow-hidden rounded-lg bg-white p-3 font-mono text-[7px] leading-[7px] tracking-normal text-black select-none"
            >
              {status.qrText}
            </pre>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {status.url}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigator.clipboard.writeText(status.url!)}
            >
              <CopyIcon aria-hidden="true" />
              {t('common.copy')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {status.encrypted
                ? t('settings.localControl.encrypted')
                : t('settings.localControl.unencrypted')}{' '}
              ·{' '}
              {status.sleepInhibited
                ? t('settings.localControl.awake')
                : t('settings.localControl.maySleep')}
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        type="button"
        variant={status?.active ? 'destructive' : 'default'}
        className="w-fit"
        disabled={
          busy ||
          !status ||
          (!status.active && needsSelection && !selectedAddress)
        }
        onClick={toggle}
      >
        {busy && <Spinner />}
        {status?.active
          ? t('settings.localControl.disable')
          : t('settings.localControl.enable')}
      </Button>
    </div>
  );
}
