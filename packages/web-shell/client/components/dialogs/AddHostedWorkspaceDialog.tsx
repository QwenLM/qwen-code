import { useCallback, useEffect, useRef, useState } from 'react';
import { DaemonClient, type DaemonCapabilities } from '@qwen-code/sdk/daemon';
import {
  getAllowedDaemonOrigin,
  getDaemonBaseUrl,
  buildDaemonConnectionUrl,
  getDaemonToken,
  persistDaemonToken,
} from '../../config/daemon';
import {
  getWorkspaceReturnUrl,
  readWorkspaceHosts,
  rememberWorkspaceHost,
  openHostedWorkspace,
} from '../../config/workspace-hosts';
import { useI18n } from '../../i18n';
import {
  AddWorkspaceDialog,
  type WorkspacePathSuggestions,
} from './AddWorkspaceDialog';
import { DialogShell } from './DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Laptop, Server } from 'lucide-react';

export function AddHostedWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [resume] = useState(() =>
    new URLSearchParams(window.location.search).has('addWorkspace'),
  );
  const resumed = useRef(false);
  const addedRef = useRef(false);
  const [returnTo] = useState(() => {
    const current = new URL(window.location.href);
    const saved = getWorkspaceReturnUrl();
    if (saved) return saved;
    current.searchParams.delete('addWorkspace');
    current.searchParams.delete('workspaceReturn');
    current.searchParams.delete('token');
    current.hash = '';
    return current.toString();
  });
  const close = () => {
    if (addedRef.current) return;
    if (returnTo !== window.location.href) window.location.assign(returnTo);
    else onClose();
  };
  const [kind, setKind] = useState<'local' | 'remote'>(() =>
    resume && getDaemonBaseUrl() ? 'remote' : 'local',
  );
  const [address, setAddress] = useState(
    () =>
      (resume ? getDaemonBaseUrl() : '') ||
      readWorkspaceHosts().find(
        (host) => host.origin !== window.location.origin,
      )?.origin ||
      '',
  );
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<{
    origin: string;
    client: DaemonClient;
    capabilities: DaemonCapabilities;
  }>();
  const [hosts] = useState(readWorkspaceHosts);
  const connect = useCallback(async () => {
    const origin =
      kind === 'local'
        ? window.location.origin
        : getAllowedDaemonOrigin(address.trim());
    if (!origin) {
      setError(t('workspaceHost.invalidAddress'));
      return;
    }
    setBusy(true);
    setError('');
    const candidate = token.trim() || getDaemonToken(origin);
    if (origin !== (getDaemonBaseUrl() || window.location.origin)) {
      const href = buildDaemonConnectionUrl(origin, window.location.href);
      if (!href) return;
      if (candidate) persistDaemonToken(candidate, origin);
      const url = new URL(href);
      url.searchParams.set('addWorkspace', '1');
      url.searchParams.set('workspaceReturn', returnTo);
      window.location.assign(url.toString());
      return;
    }
    const client = new DaemonClient({ baseUrl: origin, token: candidate });
    try {
      const capabilities = await client.capabilities();
      if (!capabilities.features.includes('dynamic_workspace_registration'))
        throw new Error(t('workspaceHost.unsupported'));
      if (candidate) persistDaemonToken(candidate, origin);
      rememberWorkspaceHost(
        origin,
        (capabilities.workspaces || []).filter((ws) => ws.kind !== 'live'),
      );
      setTarget({ origin, client, capabilities });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [kind, address, token, t, returnTo]);
  useEffect(() => {
    if (!resume || resumed.current) return;
    resumed.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete('addWorkspace');
    url.searchParams.delete('workspaceReturn');
    window.history.replaceState(window.history.state, '', url);
    void connect();
  }, [resume, connect]);
  const suggest = useCallback(
    async (prefix: string) => {
      if (!target) throw new Error('No workspace host selected');
      return (await target.client.workspacePathSuggestions(
        prefix,
      )) as WorkspacePathSuggestions;
    },
    [target],
  );
  if (target)
    return (
      <AddWorkspaceDialog
        browseDirectories
        onClose={close}
        onBack={() => setTarget(undefined)}
        initialPath={
          target.capabilities.workspaceCwd?.replace(/[^\\/]+[\\/]?$/, '') || '/'
        }
        daemonAddress={
          kind === 'local' ? t('workspaceHost.local') : target.origin
        }
        onSuggest={suggest}
        onPick={
          kind === 'local' &&
          target.capabilities.features.includes('native_directory_picker')
            ? async () => {
                const result =
                  (await target.client.workspaceDirectoryPicker()) as {
                    selected: boolean;
                    path?: string;
                  };
                return result.selected ? result.path : undefined;
              }
            : undefined
        }
        displayNameEnabled={target.capabilities.features.includes(
          'workspace_display_name',
        )}
        persistenceSupported={target.capabilities.features.includes(
          'persistent_workspace_registration',
        )}
        onAdd={async (cwd, persist, displayName) => {
          const existing = target.capabilities.workspaces?.find(
            (ws) =>
              ws.cwd.replace(/[\\/]+$/, '') === cwd.replace(/[\\/]+$/, ''),
          );
          if (existing) {
            if (displayName && displayName !== existing.displayName) {
              await target.client.updateWorkspace(existing.id, { displayName });
            }
            addedRef.current = true;
            openHostedWorkspace(target.origin, existing.id);
            return;
          }
          const added = await target.client.addWorkspace(cwd, {
            persist,
            displayName,
          });
          if (persist && added.persisted !== true)
            throw new Error(t('sidebar.addWorkspacePersistenceError'));
          rememberWorkspaceHost(target.origin, [
            ...(target.capabilities.workspaces || []).filter(
              (ws) => ws.id !== added.id && ws.kind !== 'live',
            ),
            added,
          ]);
          openHostedWorkspace(target.origin, added.id);
          addedRef.current = true;
        }}
      />
    );
  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      onClose={close}
      size="md"
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <fieldset disabled={busy} className="grid grid-cols-2 gap-3">
          <legend className="mb-3">{t('workspaceHost.location')}</legend>
          {(['local', 'remote'] as const).map((value) => (
            <label
              key={value}
              className={`cursor-pointer rounded-lg border p-4 ${kind === value ? 'border-primary bg-accent' : 'border-border'}`}
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
                className="mr-2"
              />
              {t(`workspaceHost.${value}`)}
              {value === 'local' ? (
                <Laptop className="mt-3 size-6" aria-hidden="true" />
              ) : (
                <Server className="mt-3 size-6" aria-hidden="true" />
              )}
              <p className="mt-2 text-sm text-muted-foreground">
                {t(`workspaceHost.${value}Hint`)}
              </p>
            </label>
          ))}
        </fieldset>
        {kind === 'remote' && (
          <>
            <Label htmlFor="workspace-host-address">
              {t('workspaceHost.server')}
            </Label>
            <Input
              id="workspace-host-address"
              list="workspace-known-hosts"
              placeholder="https://server.example.com"
              value={address}
              disabled={busy}
              onChange={(event) => {
                setAddress(event.target.value);
                setToken('');
              }}
              required
            />
            <datalist id="workspace-known-hosts">
              {hosts
                .filter((host) => host.origin !== window.location.origin)
                .map((host) => (
                  <option key={host.origin} value={host.origin} />
                ))}
            </datalist>
          </>
        )}
        {(kind === 'remote' || error) && (
          <>
            <Label htmlFor="workspace-host-token">
              {t('workspaceHost.token')}
            </Label>
            <Input
              id="workspace-host-token"
              type="password"
              autoComplete="off"
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
            />
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {t(busy ? 'workspaceHost.connecting' : 'workspaceHost.next')}
        </Button>
      </form>
    </DialogShell>
  );
}
