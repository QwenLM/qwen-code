import { useState } from 'react';
import { getDaemonBaseUrl, getDaemonToken } from '../../config/daemon';
import { readRemoteConnections } from '../../config/remote-connections';
import { startRemoteWorkspaceAdd } from '../../config/remote-workspace-add';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '../ui/field';
import { LaptopIcon, ServerIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

export function AddRemoteWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [connections] = useState(() => {
    const current = getDaemonBaseUrl();
    return Array.from(
      new Set([
        ...readRemoteConnections(),
        ...(current && current !== window.location.origin ? [current] : []),
      ]),
    );
  });
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [remoteOrigin, setRemoteOrigin] = useState(connections[0] ?? '');
  const [error, setError] = useState('');

  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
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
                return (
                  <label
                    key={value}
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
                      disabled
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer'
                    } ${
                      kind === value
                        ? 'border-primary bg-accent'
                        : 'border-border hover:bg-accent/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="workspace-host-kind"
                      value={value}
                      checked={kind === value}
                      disabled={disabled}
                      onChange={() => {
                        setKind(value);
                        setError('');
                      }}
                      className="sr-only"
                    />
                    <Icon
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
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
                  </label>
                );
              })}
            </div>
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
                      {new URL(origin).host}
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
