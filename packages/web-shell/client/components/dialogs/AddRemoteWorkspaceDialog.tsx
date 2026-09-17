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

export function AddRemoteWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState(() => getDaemonBaseUrl());
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  return (
    <DialogShell
      title={t('sidebar.addRemoteWorkspace')}
      onClose={onClose}
      size="md"
    >
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const origin = getAllowedDaemonOrigin(address.trim());
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
            <FieldDescription>{t('workspaceHost.tokenHint')}</FieldDescription>
          </Field>
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
