import { useCallback, useEffect, useRef, useState } from 'react';
import { DaemonClient, type DaemonCapabilities } from '@qwen-code/sdk/daemon';
import {
  getAllowedDaemonOrigin,
  getDaemonBaseUrl,
  buildDaemonConnectionUrl,
  confirmDaemonTarget,
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../ui/field';
import { Laptop, Server } from 'lucide-react';

export function AddHostedWorkspaceDialog({
  onClose,
  onAddCurrent,
}: {
  onClose: () => void;
  /** Registers a folder on the daemon this page is connected to, in place. */
  onAddCurrent?: (
    cwd: string,
    persist: boolean,
    displayName?: string,
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const [resume] = useState(() =>
    new URLSearchParams(window.location.search).has('addWorkspace'),
  );
  const resumed = useRef(false);
  // 'navigating': a workspace is opening by page navigation, so closing must
  // not also send the user back; 'added': registered in place, just close.
  const outcomeRef = useRef<'navigating' | 'added' | undefined>(undefined);
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
    if (outcomeRef.current === 'navigating') return;
    if (!outcomeRef.current && returnTo !== window.location.href) {
      window.location.assign(returnTo);
    } else {
      onClose();
    }
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
      confirmDaemonTarget(origin);
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
          target.capabilities.workspaceCwd?.replace(/[^\\/]+[\\/]?$/, '') ||
          target.capabilities.workspaceCwd ||
          '/'
        }
        daemonAddress={
          kind === 'local' ? t('workspaceHost.thisComputer') : target.origin
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
          // Drive-letter paths compare case-insensitively, with either separator.
          const comparable = (value: string) => {
            const trimmed = value.replace(/[\\/]+$/, '');
            return /^[A-Za-z]:/.test(trimmed)
              ? trimmed.replace(/\//g, '\\').toLowerCase()
              : trimmed;
          };
          const existing = target.capabilities.workspaces?.find(
            (ws) => comparable(ws.cwd) === comparable(cwd),
          );
          if (existing) {
            if (displayName && displayName !== existing.displayName) {
              await target.client.updateWorkspace(existing.id, { displayName });
            }
            outcomeRef.current = 'navigating';
            openHostedWorkspace(target.origin, existing.id);
            return;
          }
          if (
            onAddCurrent &&
            target.origin === (getDaemonBaseUrl() || window.location.origin)
          ) {
            // The app is already connected to this daemon: register through its
            // workspace lane so the list refreshes and a trusted folder opens
            // without a page reload.
            await onAddCurrent(cwd, persist, displayName);
            outcomeRef.current = 'added';
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
          outcomeRef.current = 'navigating';
          openHostedWorkspace(target.origin, added.id);
        }}
      />
    );
  const knownHosts = hosts.filter(
    (host) => host.origin !== window.location.origin,
  );
  return (
    <DialogShell
      title={t('sidebar.addWorkspaceTitle')}
      onClose={close}
      size="md"
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <FieldGroup>
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <legend className="mb-3 p-0 text-sm font-medium">
              {t('workspaceHost.location')}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              {(['local', 'remote'] as const).map((value) => {
                const Icon = value === 'local' ? Laptop : Server;
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
            <Field>
              <FieldLabel htmlFor="workspace-host-address">
                {t('workspaceHost.server')}
              </FieldLabel>
              <Input
                id="workspace-host-address"
                placeholder="https://server.example.com:4170"
                value={address}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setToken('');
                }}
                required
              />
              {knownHosts.length > 0 && (
                <div
                  role="group"
                  aria-label={t('workspaceHost.recentServers')}
                  className="flex flex-wrap gap-2"
                >
                  {knownHosts.map((host) => (
                    <Button
                      key={host.origin}
                      type="button"
                      size="sm"
                      variant={
                        address.trim() === host.origin ? 'secondary' : 'outline'
                      }
                      disabled={busy}
                      title={host.origin}
                      onClick={() => {
                        setAddress(host.origin);
                        setToken('');
                      }}
                    >
                      <Server aria-hidden="true" />
                      {new URL(host.origin).host}
                    </Button>
                  ))}
                </div>
              )}
            </Field>
          )}
          {(kind === 'remote' || error) && (
            <Field>
              <FieldLabel htmlFor="workspace-host-token">
                {t('workspaceHost.token')}
              </FieldLabel>
              <Input
                id="workspace-host-token"
                type="password"
                autoComplete="off"
                value={token}
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
              />
              <FieldDescription>
                {t('workspaceHost.tokenHint')}
              </FieldDescription>
            </Field>
          )}
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={close}
            disabled={busy}
          >
            {t('sidebar.addWorkspaceCancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t(busy ? 'workspaceHost.connecting' : 'workspaceHost.next')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
