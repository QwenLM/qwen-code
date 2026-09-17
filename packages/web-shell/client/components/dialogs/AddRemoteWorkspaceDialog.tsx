import { useState } from 'react';
import { getDaemonBaseUrl, getDaemonToken } from '../../config/daemon';
import {
  formatOriginHost,
  listRemoteComputers,
} from '../../config/remote-connections';
import { startRemoteWorkspaceAdd } from '../../config/remote-workspace-add';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field';
import { CheckIcon, LaptopIcon, ServerIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

export function AddRemoteWorkspaceDialog({
  onClose,
  onContinueHere,
  onConnectComputer,
}: {
  onClose: () => void;
  /**
   * Continue to the folder step without leaving the page. Used whenever the
   * chosen computer is the one this tab already talks to.
   */
  onContinueHere: () => void;
  onConnectComputer: () => void;
}) {
  const { t } = useI18n();
  const [connections] = useState(listRemoteComputers);
  const [currentOrigin] = useState(
    () => getDaemonBaseUrl() || window.location.origin,
  );
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [remoteOrigin, setRemoteOrigin] = useState(connections[0] ?? '');
  const [error, setError] = useState('');

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      subtitle={t('workspaceHost.locationSubtitle')}
      onClose={onClose}
      size="md"
    >
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const origin =
            kind === 'local' ? window.location.origin : remoteOrigin;
          if (!origin) {
            setError(t('workspaceHost.noRemoteConnections'));
            return;
          }
          // Only a different computer needs the full-page handover. Reloading
          // the shell to browse folders on the daemon it is already connected
          // to would drop the open session, its socket and the composer draft.
          if (origin === currentOrigin) {
            onContinueHere();
            return;
          }
          if (!startRemoteWorkspaceAdd(origin, getDaemonToken(origin))) {
            setError(t('workspaceHost.navigationUnavailable'));
          }
        }}
      >
        <FieldGroup>
          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-3 p-0 text-sm font-medium">
              {t('workspaceHost.location')}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              {(['local', 'remote'] as const).map((value) => {
                const Icon = value === 'local' ? LaptopIcon : ServerIcon;
                const disabled = value === 'remote' && connections.length === 0;
                const selected = kind === value;
                return (
                  <label
                    key={value}
                    className={`relative flex items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
                      disabled
                        ? 'cursor-not-allowed opacity-60'
                        : 'cursor-pointer'
                    } ${
                      selected
                        ? 'border-primary bg-accent ring-1 ring-primary'
                        : 'border-border hover:bg-accent/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="workspace-host-kind"
                      value={value}
                      checked={selected}
                      disabled={disabled}
                      onChange={() => {
                        setKind(value);
                        setError('');
                      }}
                      className="sr-only"
                    />
                    <Icon
                      className={`mt-0.5 size-5 shrink-0 ${
                        selected ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium">
                        {t(`workspaceHost.${value}`)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(
                          disabled
                            ? 'workspaceHost.noRemoteConnections'
                            : `workspaceHost.${value}Hint`,
                        )}
                      </span>
                    </span>
                    {selected && (
                      <CheckIcon
                        className="absolute top-2 right-2 size-4 text-primary"
                        aria-hidden="true"
                      />
                    )}
                  </label>
                );
              })}
            </div>
            {connections.length === 0 && (
              // The disabled card states the requirement; this is the way out
              // of it, so it is a control rather than another line of prose.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-2 h-auto px-0"
                onClick={onConnectComputer}
              >
                {t('workspaceHost.connectComputer')}
              </Button>
            )}
          </fieldset>
          {kind === 'remote' && connections.length > 0 && (
            <Field>
              <FieldLabel id="remote-workspace-computer-label">
                {t('workspaceHost.computer')}
              </FieldLabel>
              <Select value={remoteOrigin} onValueChange={setRemoteOrigin}>
                <SelectTrigger
                  className="w-full"
                  aria-labelledby="remote-workspace-computer-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {connections.map((origin) => (
                    <SelectItem key={origin} value={origin}>
                      <ServerIcon aria-hidden="true" />
                      {formatOriginHost(origin)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('sidebar.addWorkspaceCancel')}
          </Button>
          <Button type="submit">{t('workspaceHost.next')}</Button>
        </div>
      </form>
    </DialogShell>
  );
}
