import { useEffect, useState } from 'react';
import { CopyIcon, WifiIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/webui/daemon-react-sdk';
import { useI18n } from '../../i18n';
import {
  warnClipboardWriteFailure,
  writeClipboardText,
} from '../../utils/clipboard';
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
import {
  LocalControlRequestError,
  requestLocalControl,
  type LanCandidate,
  type LocalControlStatus,
} from '../local-control-api';

function getLocalControlTarget(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('daemon');
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}`;
}

// Re-run on every status update, not just mount: enable/disable responses
// carry a fresh candidate list, and the selector only renders with 2+
// candidates — so a selection that outlived a network change (same adapter,
// new DHCP address) would otherwise be silently re-sent with no way to fix it.
function reconcileSelection(
  interfaces: LanCandidate[] | undefined,
  current: string,
): string {
  if (!interfaces) return current;
  if (interfaces.length === 1) return interfaces[0]!.address;
  if (current && !interfaces.some((c) => c.address === current)) return '';
  return current;
}

export function LocalControlSettingsCard() {
  const { t } = useI18n();
  const { baseUrl, token } = useWorkspace();
  const [status, setStatus] = useState<LocalControlStatus>();
  const [selectedAddress, setSelectedAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let ignore = false;
    // A re-run after a failed fetch must not keep rendering the stale
    // error next to fresh status; `toggle()` is the other clearing path.
    setError('');
    requestLocalControl(baseUrl, token, 'GET', '/workspace/local-control')
      .then((next) => {
        if (ignore) return;
        setStatus(next);
        setSelectedAddress((current) =>
          reconcileSelection(next.interfaces, current),
        );
      })
      .catch((failure: unknown) => {
        if (!ignore) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [baseUrl, token]);

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
            target: getLocalControlTarget(),
          };
      const next = await requestLocalControl(
        baseUrl,
        token,
        'POST',
        path,
        body,
      );
      setStatus(next);
      setSelectedAddress((current) =>
        reconcileSelection(next.interfaces, current),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // The enable route attaches the fresh candidate list to 409s; reconcile
      // from it so a selection that outlived a network change can recover
      // without a page remount.
      const recovered =
        failure instanceof LocalControlRequestError
          ? failure.payload?.interfaces
          : undefined;
      if (recovered) {
        setStatus((prev) => (prev ? { ...prev, interfaces: recovered } : prev));
        setSelectedAddress((current) => reconcileSelection(recovered, current));
      }
    } finally {
      setBusy(false);
    }
  };

  const needsSelection = (status?.interfaces?.length ?? 0) > 1;

  return (
    <div
      className="flex flex-col gap-4 px-5 py-4 max-md:px-4"
      aria-live="polite"
    >
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
            {(status?.interfaces ?? []).map((network) => (
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
              onClick={() =>
                void writeClipboardText(status.url!).catch(
                  warnClipboardWriteFailure,
                )
              }
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

      {status?.active && !status.url && status.urlRedacted && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t('settings.localControl.urlRedacted')}
        </p>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

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
