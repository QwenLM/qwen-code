import { useEffect, useRef, useState } from 'react';
import { CopyIcon, WifiIcon } from 'lucide-react';
import { useWorkspace } from '@qwen-code/web-shell/daemon-react-sdk';
import { useDaemonAvailability } from '../../daemon/availability-context.js';
import { isDaemonUnavailableError } from '../../daemon/availability.js';
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

interface RetainedSelection {
  candidate: LanCandidate;
  /**
   * The daemon granted this address from `--local-control-address`. Such an
   * address is never an automatic candidate by construction, so its absence
   * from a fresh candidate list says nothing about staleness.
   */
  granted: boolean;
}

interface SelectionState {
  /** The address shown as selected in the picker. */
  selected: string;
  /**
   * Whether `selected` must be posted as `address`: a retained address an
   * address-less enable would not resolve to, or any selection while several
   * candidates make an address-less enable ambiguous. Recomputed on every
   * status update so a selection that becomes unambiguous goes out
   * address-less — the daemon reads a named address as the operator's later
   * choice and revokes the daemon-start grant (#14140).
   */
  named: boolean;
  /**
   * The address the daemon last committed to — reported by an active status,
   * or vouched for by the daemon's grant (`grantedAddress` /
   * `explicitCandidate`). Kept out of `interfaces` (the automatic-candidate
   * list) so a Disable→Enable round trip re-posts the operator's pick instead
   * of silently falling back to an automatic candidate (#14136).
   */
  retained: RetainedSelection | undefined;
}

// An address-less enable resolves to a retained pick only when the automatic
// candidate list is exactly that one address. Naming it then is unnecessary,
// and naming any other address is the operator's later choice, which ends the
// daemon-start grant (#14140).
function autoResolves(
  interfaces: LanCandidate[] | undefined,
  retained: RetainedSelection,
): boolean {
  return (
    interfaces?.length === 1 &&
    interfaces[0]!.address === retained.candidate.address
  );
}

// Re-run on every status update, not just mount: enable/disable responses
// carry a fresh candidate list, and the selector only renders with 2+
// candidates — so a selection that outlived a network change (same adapter,
// new DHCP address) would otherwise be silently re-sent with no way to fix it.
function reconcileSelection(
  interfaces: LanCandidate[] | undefined,
  current: SelectionState,
  retained: RetainedSelection | undefined,
): SelectionState {
  if (!interfaces) return { ...current, retained };
  if (retained && current.selected === retained.candidate.address) {
    return {
      ...current,
      named: !autoResolves(interfaces, retained),
      retained,
    };
  }
  if (
    current.selected &&
    interfaces.some((c) => c.address === current.selected) &&
    // With 2+ candidates an address-less enable is ambiguous, but naming the
    // auto-filled fallback would revoke the standing grant. Hand the choice
    // back to the retained grant below instead (#14140).
    !(
      interfaces.length > 1 &&
      retained?.granted &&
      retained.candidate.address !== current.selected
    )
  ) {
    // Two or more candidates make an address-less enable ambiguous, so the
    // displayed auto-fill must be posted by name — clicking the row already
    // shown fires no change event, leaving that click as the only way out.
    return {
      ...current,
      named: interfaces.length > 1,
      retained,
    };
  }
  // The committed pick outranks the single-candidate auto-fill: it is the
  // address the operator (or the daemon's grant) actually chose.
  if (retained) {
    return {
      selected: retained.candidate.address,
      named: !autoResolves(interfaces, retained),
      retained,
    };
  }
  // A lone candidate is a fallback the daemon may pick for us, not a named
  // choice: posting it as one would supersede the daemon-start grant.
  if (interfaces.length === 1) {
    return { selected: interfaces[0]!.address, named: false, retained };
  }
  return { selected: '', named: false, retained };
}

function reconcileRetained(
  retained: RetainedSelection | undefined,
  next: LocalControlStatus,
): RetainedSelection | undefined {
  // What the daemon is serving right now is the strongest truth. `granted`
  // reads provenance (`grantedAddress`), not the liveness probe: the host can
  // stop holding a granted address while the listener stays bound to it.
  if (next.active && next.address) {
    return {
      candidate: {
        interfaceName: next.interfaceName ?? '',
        address: next.address,
      },
      granted:
        next.grantedAddress === next.address ||
        next.explicitCandidate?.address === next.address,
    };
  }
  // The daemon vouches for its CLI-granted address only while the host still
  // holds it.
  if (next.explicitCandidate) {
    return { candidate: next.explicitCandidate, granted: true };
  }
  // The grant outlives the host holding the address, so a card mounted after
  // a VPN drop still offers it instead of auto-filling a candidate the
  // operator explicitly avoided.
  if (next.grantedAddress) {
    return {
      candidate: { interfaceName: '', address: next.grantedAddress },
      granted: true,
    };
  }
  // A non-empty candidate list that no longer contains a retained automatic
  // pick proves it stale (same adapter, new DHCP address) — drop it so the
  // picker recovers. A granted pick is never in that list, and an empty or
  // absent list proves nothing at all.
  if (
    retained &&
    !retained.granted &&
    next.interfaces &&
    next.interfaces.length > 0 &&
    !next.interfaces.some((c) => c.address === retained.candidate.address)
  ) {
    return undefined;
  }
  return retained;
}

export function LocalControlSettingsCard() {
  const { t } = useI18n();
  const translateRef = useRef(t);
  translateRef.current = t;
  const { baseUrl, token, client } = useWorkspace();
  const available = useDaemonAvailability() === 'available';
  const [status, setStatus] = useState<LocalControlStatus>();
  const [selection, setSelection] = useState<SelectionState>({
    selected: '',
    named: false,
    retained: undefined,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!available) return;
    let ignore = false;
    // A re-run after a failed fetch must not keep rendering the stale
    // error next to fresh status; `toggle()` is the other clearing path.
    setError('');
    requestLocalControl(
      baseUrl,
      token,
      'GET',
      '/workspace/local-control',
      undefined,
      client,
    )
      .then((next) => {
        if (ignore) return;
        setStatus(next);
        setSelection((prev) => {
          const retained = reconcileRetained(prev.retained, next);
          return reconcileSelection(next.interfaces, prev, retained);
        });
      })
      .catch((failure: unknown) => {
        if (!ignore) {
          setError(
            isDaemonUnavailableError(failure)
              ? translateRef.current('daemon.connection.unavailable')
              : failure instanceof Error
                ? failure.message
                : String(failure),
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [available, baseUrl, token, client]);

  const toggle = async () => {
    if (!status || !available) return;
    setBusy(true);
    setError('');
    // Only a named choice is posted as `address`; a single-candidate
    // auto-fill goes out address-less so it cannot revoke the daemon-start
    // grant (#14140). Captured before the request: the 409 recovery below
    // needs to know whether the refused address was the retained pick.
    const postedAddress =
      !status.active && selection.named
        ? selection.selected || undefined
        : undefined;
    try {
      const path = status.active
        ? '/workspace/local-control/disable'
        : '/workspace/local-control/enable';
      const body = status.active
        ? undefined
        : {
            address: postedAddress,
            target: getLocalControlTarget(),
          };
      const next = await requestLocalControl(
        baseUrl,
        token,
        'POST',
        path,
        body,
        client,
      );
      setStatus(next);
      setSelection((prev) => {
        const retained = reconcileRetained(prev.retained, next);
        return reconcileSelection(next.interfaces, prev, retained);
      });
    } catch (failure) {
      setError(
        isDaemonUnavailableError(failure)
          ? translateRef.current('daemon.connection.unavailable')
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
      // The enable route attaches the fresh candidate list to 409s; reconcile
      // from it so a selection that outlived a network change can recover
      // without a page remount.
      const recovered =
        failure instanceof LocalControlRequestError
          ? failure.payload?.interfaces
          : undefined;
      if (recovered) {
        setStatus((prev) => (prev ? { ...prev, interfaces: recovered } : prev));
        setSelection((prev) => {
          // The daemon just refused the retained pick itself — it is gone
          // (stale DHCP, departed VPN) — so stop offering it, even when it
          // came from the CLI grant.
          const retained =
            prev.retained && postedAddress === prev.retained.candidate.address
              ? undefined
              : prev.retained;
          return reconcileSelection(recovered, prev, retained);
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const candidates = status?.interfaces ?? [];
  const retainedExtra =
    selection.retained &&
    !candidates.some((c) => c.address === selection.retained!.candidate.address)
      ? selection.retained.candidate
      : undefined;
  // The retained explicit pick renders as its own row, so a card holding one
  // still offers (and pre-selects) it even with zero automatic candidates.
  const needsSelection = retainedExtra !== undefined || candidates.length > 1;

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
        <Select
          value={selection.selected}
          onValueChange={(value) =>
            setSelection((prev) => ({ ...prev, selected: value, named: true }))
          }
        >
          <SelectTrigger
            className="w-full max-w-sm"
            aria-label={t('settings.localControl.network')}
          >
            <SelectValue
              placeholder={t('settings.localControl.selectNetwork')}
            />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((network) => (
              <SelectItem key={network.address} value={network.address}>
                {network.interfaceName} · {network.address}
              </SelectItem>
            ))}
            {retainedExtra && (
              <SelectItem
                key={retainedExtra.address}
                value={retainedExtra.address}
              >
                {retainedExtra.interfaceName
                  ? `${retainedExtra.interfaceName} · `
                  : ''}
                {retainedExtra.address} (
                {t('settings.localControl.explicitPick')})
              </SelectItem>
            )}
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
          !available ||
          busy ||
          !status ||
          (!status.active && needsSelection && !selection.selected)
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
