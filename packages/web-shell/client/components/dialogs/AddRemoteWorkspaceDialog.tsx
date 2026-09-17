import { useState } from 'react';
import {
  getAllowedDaemonOrigin,
  getDaemonBaseUrl,
  getDaemonToken,
} from '../../config/daemon';
import { startRemoteWorkspaceAdd } from '../../config/remote-workspace-add';
import { useI18n } from '../../i18n';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { LaptopIcon, ServerIcon } from 'lucide-react';

export function AddRemoteWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<'local' | 'remote'>('remote');
  const [address, setAddress] = useState(() => {
    const current = getDaemonBaseUrl();
    return current && current !== window.location.origin ? current : '';
  });
  const [token, setToken] = useState('');
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
            kind === 'local'
              ? window.location.origin
              : getAllowedDaemonOrigin(address.trim());
          if (!origin) {
            setError(t('workspaceHost.invalidAddress'));
            return;
          }
          const candidate = token.trim() || getDaemonToken(origin);
          if (!startRemoteWorkspaceAdd(origin, candidate)) {
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
                return (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring/50 ${
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
                      onChange={() => {
                        setKind(value);
                        setToken('');
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
                        {t(`workspaceHost.${value}Hint`)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {kind === 'remote' && (
            <>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="remote-workspace-host-address">
                  {t('workspaceHost.server')}
                </FieldLabel>
                <Input
                  id="remote-workspace-host-address"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  autoFocus
                  placeholder="https://server.example.com:4170"
                  value={address}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setToken('');
                    setError('');
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="remote-workspace-host-token">
                  {t('workspaceHost.token')}
                </FieldLabel>
                <Input
                  id="remote-workspace-host-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => {
                    setToken(event.target.value);
                    setError('');
                  }}
                />
                <FieldDescription>
                  {t('workspaceHost.tokenHint')}
                </FieldDescription>
              </Field>
            </>
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
