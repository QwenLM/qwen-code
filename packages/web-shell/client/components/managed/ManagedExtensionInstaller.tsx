import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type {
  ManagedExtensionCatalog,
  ManagedExtensionImportMetadata,
  ManagedExtensionInspection,
  ManagedExtensionSnapshot,
} from './managed-extension-types';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';
import {
  continueManagedExtensionInstall,
  createManagedExtensionInstall,
  managedExtensionSourceDigest,
  ManagedExtensionInstallInputRequired,
  ManagedExtensionInstallAuthorizationRequired,
  parseManagedExtensionInstall,
  isManagedExtensionInstallActive,
  type ManagedExtensionInstallCommand,
} from './managed-extension-install';
import type {
  ManagedMcpOAuthRequirement,
  ManagedMcpOAuthSnapshot,
} from './managed-mcp-oauth-types';
import { ManagedMcpOAuthPanel } from './ManagedMcpOAuthPanel';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';

export interface ManagedExtensionInstallerProps {
  provider: ManagedAgentProvider;
  workspaceId: string;
  sessionId: string;
  catalog: ManagedExtensionCatalog;
  snapshot: ManagedExtensionSnapshot;
  initialKind?: 'skill' | 'extension' | 'mcp';
  skillsOnly?: boolean;
  editing?: { extensionId: string; inspection: ManagedExtensionInspection };
  onChanged: () => void;
  onInstalled?: () => void;
}

function stringRecord(text: string): Record<string, string> {
  const result: unknown = JSON.parse(text);
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    Object.values(result).some((value) => typeof value !== 'string')
  )
    throw new Error('Expected a string-valued object.');
  return result as Record<string, string>;
}

export function buildManagedMcpInput(input: {
  name: string;
  serverName: string;
  transport: string;
  command: string;
  args: string;
  url: string;
  environment: string;
  headers: string;
  secretKeys: string[];
  auth?: ManagedMcpOAuthRequirement;
}) {
  const settings = input.secretKeys.map((key) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw new Error('Invalid setting name.');
    return { name: key, envVar: key, sensitive: true };
  });
  if (new Set(input.secretKeys).size !== settings.length)
    throw new Error('Duplicate setting name.');
  const args: unknown = JSON.parse(input.args);
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))
    throw new Error('Arguments must be a string array.');
  const environment = stringRecord(input.environment);
  const headers = stringRecord(input.headers);
  if (
    [
      ...args,
      ...Object.values(environment),
      ...Object.values(headers),
      input.url,
      input.command,
    ].some((value) => String(value).includes('[redacted]'))
  )
    throw new Error('Redacted values must be entered again.');
  for (const value of Object.values(headers)) {
    const reference = /^(?:Bearer )?\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i.exec(
      value,
    );
    if (!reference || !input.secretKeys.includes(reference[1]!))
      throw new Error(
        'Credential headers must use a declared secret placeholder.',
      );
  }
  for (const value of Object.values(environment)) {
    const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
    if (!reference || !input.secretKeys.includes(reference[1]!))
      throw new Error('Declared credentials must use settings placeholders.');
  }
  if (
    input.auth &&
    (input.transport === 'stdio' ||
      input.auth.resourceUri !== input.url ||
      Object.keys(headers).some((key) => key.toLowerCase() === 'authorization'))
  )
    throw new Error(
      'OAuth requires its configured HTTP resource and no static Authorization header.',
    );
  const recipe =
    input.transport === 'stdio'
      ? { command: input.command, args, env: environment }
      : {
          url: input.url,
          headers,
          type:
            input.transport === 'streamable-http' ? 'http' : input.transport,
          ...(input.auth ? { auth: input.auth } : {}),
        };
  return new Blob(
    [
      JSON.stringify({
        name: input.name,
        serverName: input.serverName,
        recipe,
        settings,
      }),
    ],
    { type: 'application/json' },
  );
}

export function ManagedExtensionInstaller(
  props: ManagedExtensionInstallerProps,
) {
  const {
    provider,
    workspaceId,
    sessionId,
    catalog,
    snapshot,
    onChanged,
    editing,
  } = props;
  const { t } = useI18n();
  const management = provider.extensions;
  const [kind, setKind] = useState(props.initialKind ?? 'skill');
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const [serverName, setServerName] = useState('');
  const [target, setTarget] = useState('linux:x64');
  const [updateId, setUpdateId] = useState(editing?.extensionId ?? 'new');
  const [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('[]');
  const [url, setUrl] = useState('');
  const [environment, setEnvironment] = useState('{}');
  const [headers, setHeaders] = useState('{}');
  const [useOAuth, setUseOAuth] = useState(false);
  const [oauthProvider, setOAuthProvider] = useState('');
  const [oauthScopes, setOAuthScopes] = useState('');
  const [oauthProviders, setOAuthProviders] = useState<
    NonNullable<ManagedMcpOAuthSnapshot['providers']>
  >([]);
  const [authorizationPins, setAuthorizationPins] =
    useState<ManagedExtensionSnapshot['extensions']>();
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [keepSettings, setKeepSettings] = useState(true);
  const [pending, setPending] = useState<ManagedExtensionInstallCommand>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<{
    identity: string;
    file: File | undefined;
    source: Blob;
    metadata: ManagedExtensionImportMetadata;
    inspection: ManagedExtensionInspection;
    reusableSettingsRevision?: number;
  }>();
  const request = useRef<AbortController | undefined>(undefined);
  const source = useRef<Blob | undefined>(undefined);
  const mounted = useRef(true);
  const clientId = getManagedClientId(
    management?.storageScope ?? 'managed-extensions',
  );
  const storageKey = management?.storageScope
    ? `managed-extension-install:${management.storageScope}:${workspaceId}:${sessionId}${props.skillsOnly ? ':skills' : ''}`
    : undefined;

  useEffect(() => {
    if (!provider.mcpOAuth) return;
    const abort = new AbortController();
    setOAuthProviders([]);
    void provider.mcpOAuth
      .query(sessionId, undefined, { clientId, signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && value.supported)
          setOAuthProviders(value.providers ?? []);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [provider, sessionId, clientId]);

  useEffect(() => {
    mounted.current = true;
    setPending(undefined);
    setPreview(undefined);
    setAuthorizationPins(undefined);
    setSecrets({});
    setFile(undefined);
    setStatus('');
    setFailed(false);
    setBusy(false);
    if (storageKey) {
      try {
        const raw = sessionStorage.getItem(storageKey);
        const saved =
          raw && parseManagedExtensionInstall(raw, workspaceId, sessionId);
        if (saved) {
          setPending(saved);
          setKind(saved.metadata.sourceKind);
          setTarget(
            `${saved.metadata.target.platform}:${saved.metadata.target.arch}`,
          );
          setSecretKeys(saved.settingsKeys);
          setStatus('managed.install.savedNotApplied');
        } else if (raw) sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
    }
    return () => {
      mounted.current = false;
      request.current?.abort();
      source.current = undefined;
    };
  }, [storageKey, workspaceId, sessionId, provider]);

  useEffect(() => {
    if (!editing) return;
    const { inspection } = editing;
    const server = inspection.mcpServers[0];
    if (inspection.mcpServers.length !== 1 || !server) return;
    setKind('mcp');
    setUpdateId(editing.extensionId);
    setName(inspection.manifest.name);
    setServerName(server.name);
    const recipe = server.recipe;
    setTransport(
      typeof recipe['command'] === 'string'
        ? 'stdio'
        : recipe['type'] === 'sse'
          ? 'sse'
          : 'streamable-http',
    );
    setCommand(typeof recipe['command'] === 'string' ? recipe['command'] : '');
    setArgs(JSON.stringify(recipe['args'] ?? []));
    setUrl(
      typeof recipe['httpUrl'] === 'string'
        ? recipe['httpUrl']
        : typeof recipe['url'] === 'string'
          ? recipe['url']
          : '',
    );
    setEnvironment(JSON.stringify(recipe['env'] ?? {}, null, 2));
    setHeaders(JSON.stringify(recipe['headers'] ?? {}, null, 2));
    if (recipe['auth'] && typeof recipe['auth'] === 'object') {
      const auth = recipe['auth'] as Record<string, unknown>;
      setUseOAuth(auth['type'] === 'oauth');
      setOAuthProvider(
        typeof auth['providerId'] === 'string' ? auth['providerId'] : '',
      );
      setOAuthScopes(
        Array.isArray(auth['scopes']) ? auth['scopes'].join(', ') : '',
      );
    }
    setSecretKeys(inspection.settings.map((entry) => entry.envVar));
    setTarget(
      `${inspection.manifest.target.platform}:${inspection.manifest.target.arch}`,
    );
  }, [editing]);

  const save = (value: ManagedExtensionInstallCommand | undefined) => {
    if (!mounted.current) return;
    setPending(value);
    if (storageKey) {
      try {
        if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
    }
  };
  const allowed =
    !!management?.importPackage &&
    !!management.previewPackage &&
    !!management.lookupPackageOperation &&
    !!management.lookupApplyOperation &&
    catalog.selfService?.supported === true &&
    catalog.selfService.canPublish &&
    snapshot.selfService?.supported === true &&
    snapshot.selfService.canApply;
  const blocked =
    !!snapshot.operation &&
    !['active', 'failed'].includes(snapshot.operation.state);
  const identity = JSON.stringify([
    kind,
    name,
    serverName,
    target,
    updateId,
    transport,
    command,
    args,
    url,
    environment,
    headers,
    secretKeys,
    useOAuth,
    oauthProvider,
    oauthScopes,
  ]);
  const previewMatches =
    preview?.identity === identity && preview.file === file;
  const canKeepSettings =
    previewMatches && preview.reusableSettingsRevision !== undefined;
  const requiredKeys =
    pending?.settingsKeys ??
    (previewMatches
      ? preview.inspection.settings.map((entry) => entry.envVar)
      : secretKeys);
  const createSource = () =>
    kind === 'mcp'
      ? buildManagedMcpInput({
          name,
          serverName: serverName || name,
          transport,
          command,
          args,
          url,
          environment,
          headers,
          secretKeys,
          ...(useOAuth
            ? {
                auth: {
                  type: 'oauth' as const,
                  providerId: oauthProvider,
                  resourceUri: url,
                  scopes: oauthScopes
                    .split(',')
                    .map((scope) => scope.trim())
                    .filter(Boolean),
                },
              }
            : {}),
        })
      : file;
  const review = async () => {
    if (!management?.previewPackage || busy) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setFailed(false);
    setStatus('');
    try {
      const input = createSource();
      if (!input) throw new ManagedExtensionInstallInputRequired('source');
      const [platform, arch] = target.split(':') as [
        'linux' | 'darwin',
        'x64' | 'arm64' | 'any',
      ];
      const metadata: ManagedExtensionImportMetadata = {
        sourceKind: kind,
        target: { platform, arch },
        sourceDigest: await managedExtensionSourceDigest(input),
        compilerVersion: kind !== 'mcp' || useOAuth ? 2 : 1,
        ...(name ? { packageName: name } : {}),
      };
      const inspection = await management.previewPackage(
        workspaceId,
        metadata,
        input,
        { clientId, signal: controller.signal },
      );
      const old = snapshot.extensions.find(
        (pin) => pin.extensionId === updateId,
      );
      let reusableSettingsRevision: number | undefined;
      if (old?.settingsRevision !== undefined && management.inspect) {
        const previous = await management.inspect(workspaceId, old, {
          clientId,
          signal: controller.signal,
        });
        if (
          inspection.settings.every((setting) =>
            previous.settings.some((item) => item.envVar === setting.envVar),
          )
        )
          reusableSettingsRevision = old.settingsRevision;
      }
      if (!controller.signal.aborted && mounted.current)
        setPreview({
          identity,
          file,
          source: input,
          metadata,
          inspection,
          reusableSettingsRevision,
        });
    } catch {
      if (!controller.signal.aborted && mounted.current) {
        setPreview(undefined);
        setFailed(true);
        setStatus('managed.install.invalidInput');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const install = async (authorized?: ManagedExtensionInstallCommand) => {
    if (!management || busy || !allowed) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const options = { clientId, signal: controller.signal };
    setBusy(true);
    setFailed(false);
    try {
      let next = authorized ?? pending;
      if (!next) {
        if (!previewMatches)
          throw new Error('Review the package before installing.');
        source.current = preview.source;
        const current = await management.query(sessionId, options);
        controller.signal.throwIfAborted();
        if (
          current.revision !== snapshot.revision ||
          (current.operation &&
            !['active', 'failed'].includes(current.operation.state))
        )
          throw new Error('The Session configuration changed.');
        const old =
          updateId === 'new'
            ? undefined
            : current.extensions.find(
                (entry) => entry.extensionId === updateId,
              );
        const settings =
          updateId === 'new'
            ? undefined
            : await management.settings(workspaceId, updateId, options);
        controller.signal.throwIfAborted();
        next = createManagedExtensionInstall(
          {
            workspaceId,
            sessionId,
            metadata: preview.metadata,
            ...(updateId === 'new' ? {} : { extensionId: updateId }),
            expectedSettingsRevision: settings?.settingsRevision ?? 0,
            settingsKeys: requiredKeys,
            requiresOAuth: preview.inspection.mcpServers.some(
              (server) => !!server.recipe['auth'],
            ),
            ...(keepSettings &&
            old?.settingsRevision !== undefined &&
            old.settingsRevision === preview.reusableSettingsRevision
              ? { keepSettingsRevision: old.settingsRevision }
              : {}),
          },
          current,
        );
        save(next);
      } else if (!source.current && next.stage === 'publish') {
        source.current = createSource();
      }
      let completedCommand = next;
      const result = await continueManagedExtensionInstall(
        management,
        next,
        source.current,
        Object.keys(secrets).length ? secrets : undefined,
        options,
        (value) => {
          completedCommand = value;
          save(value);
          setStatus(`managed.install.stage.${value.stage}`);
        },
        async (value) => {
          if (!value.requiresOAuth && value.selectionVersion !== 2)
            return value;
          if (!provider.mcpOAuth)
            throw new ManagedExtensionInstallAuthorizationRequired();
          const pins = [
            ...value.extensions.filter(
              (pin) => pin.extensionId !== value.pin!.extensionId,
            ),
            value.pin!,
          ];
          const auth = await provider.mcpOAuth.query(sessionId, pins, options);
          controller.signal.throwIfAborted();
          const bindings = (value.mcpAuthBindings ?? []).filter((binding) =>
            auth.servers.some((server) => server.serverId === binding.serverId),
          );
          if (
            !auth.supported ||
            auth.servers.some(
              (server) =>
                !server.actorOwned ||
                server.state !== 'authorized' ||
                !bindings.some(
                  (binding) =>
                    binding.serverId === server.serverId &&
                    binding.credentialId === server.credentialId &&
                    binding.credentialGeneration === server.generation,
                ),
            )
          ) {
            setAuthorizationPins(pins);
            throw new ManagedExtensionInstallAuthorizationRequired();
          }
          return value.selectionVersion === 2
            ? { ...value, mcpAuthBindings: bindings }
            : value;
        },
      );
      if (controller.signal.aborted || !mounted.current) return;
      if (isManagedExtensionInstallActive(completedCommand, result)) {
        save(undefined);
        source.current = undefined;
        setPreview(undefined);
        setAuthorizationPins(undefined);
        setSecrets({});
        setStatus('managed.install.complete');
        props.onInstalled?.();
      } else setStatus('managed.install.savedNotApplied');
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setFailed(
          !(cause instanceof ManagedExtensionInstallAuthorizationRequired),
        );
        setStatus(
          cause instanceof ManagedExtensionInstallAuthorizationRequired
            ? 'managed.oauth.required'
            : cause instanceof ManagedExtensionInstallInputRequired
              ? `managed.install.required.${cause.input}`
              : 'managed.install.savedNotApplied',
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!allowed) return null;
  return (
    <Card data-managed-extension-installer>
      <CardHeader>
        <CardTitle>{t('managed.install.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {t('managed.install.description')}
        </p>
        {status && (
          <Alert variant={failed ? 'destructive' : 'default'}>
            <AlertDescription role="status">{t(status)}</AlertDescription>
          </Alert>
        )}
        {!props.skillsOnly && (
          <Select
            value={kind}
            onValueChange={(value) => {
              setUpdateId('new');
              setKind(value as typeof kind);
            }}
            disabled={busy || !!pending || !!editing}
          >
            <SelectTrigger aria-label={t('managed.install.kind')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['skill', 'extension', 'mcp'] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`managed.install.kind.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          aria-label={t('managed.install.name')}
          placeholder={t('managed.install.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy || !!editing || !!pending?.pin}
        />
        {kind !== 'mcp' ? (
          <Input
            type="file"
            accept=".zip,.tar.gz,.tgz"
            aria-label={t('managed.install.archive')}
            disabled={busy || !!pending?.pin}
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              source.current = undefined;
            }}
          />
        ) : (
          <>
            <Input
              aria-label={t('managed.install.serverName')}
              placeholder={t('managed.install.serverName')}
              value={serverName}
              disabled={busy || !!editing || !!pending?.pin}
              onChange={(event) => setServerName(event.target.value)}
            />
            <Select
              value={transport}
              onValueChange={setTransport}
              disabled={busy || !!pending?.pin}
            >
              <SelectTrigger aria-label={t('managed.install.transport')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="streamable-http">Streamable HTTP</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
              </SelectContent>
            </Select>
            {transport === 'stdio' ? (
              <>
                <Input
                  aria-label={t('managed.install.command')}
                  placeholder={t('managed.install.command')}
                  value={command}
                  disabled={busy || !!pending?.pin}
                  onChange={(event) => setCommand(event.target.value)}
                />
                <Textarea
                  aria-label={t('managed.install.arguments')}
                  value={args}
                  disabled={busy || !!pending?.pin}
                  onChange={(event) => setArgs(event.target.value)}
                />
                <Textarea
                  aria-label={t('managed.install.environment')}
                  value={environment}
                  disabled={busy || !!pending?.pin}
                  onChange={(event) => setEnvironment(event.target.value)}
                />
              </>
            ) : (
              <>
                <Input
                  aria-label={t('managed.install.url')}
                  placeholder={t('managed.install.url')}
                  value={url}
                  disabled={busy || !!pending?.pin}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <Textarea
                  aria-label={t('managed.install.headers')}
                  value={headers}
                  disabled={busy || !!pending?.pin}
                  onChange={(event) => setHeaders(event.target.value)}
                />
                {oauthProviders.length > 0 && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={useOAuth}
                        disabled={busy || !!pending?.pin}
                        onChange={(event) => setUseOAuth(event.target.checked)}
                      />
                      {t('managed.oauth.configure')}
                    </label>
                    {useOAuth && (
                      <>
                        <Select
                          value={oauthProvider}
                          disabled={busy || !!pending?.pin}
                          onValueChange={(value) => {
                            setOAuthProvider(value);
                            const configured = oauthProviders.find(
                              (entry) => entry.providerId === value,
                            );
                            if (configured) {
                              setUrl(configured.resourceUri);
                              setOAuthScopes(configured.scopes.join(', '));
                            }
                          }}
                        >
                          <SelectTrigger
                            aria-label={t('managed.oauth.provider')}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {oauthProviders.map((entry) => (
                              <SelectItem
                                key={entry.providerId}
                                value={entry.providerId}
                              >
                                {entry.providerId}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          aria-label={t('managed.oauth.scopes')}
                          value={oauthScopes}
                          disabled={busy || !!pending?.pin}
                          onChange={(event) =>
                            setOAuthScopes(event.target.value)
                          }
                        />
                        <p className="text-sm text-muted-foreground">
                          {t('managed.oauth.notice')}
                        </p>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            <p className="text-sm text-muted-foreground">
              {t('managed.install.secretHelp')}
            </p>
            {!pending && (
              <Input
                aria-label={t('managed.install.secretKeys')}
                placeholder={t('managed.install.secretKeys')}
                value={secretKeys.join(', ')}
                disabled={busy}
                onChange={(event) =>
                  setSecretKeys(
                    event.target.value
                      .split(',')
                      .map((key) => key.trim())
                      .filter(Boolean),
                  )
                }
              />
            )}
          </>
        )}
        {canKeepSettings && requiredKeys.length > 0 && !pending && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepSettings}
              onChange={(event) => setKeepSettings(event.target.checked)}
            />
            {t('managed.install.keepSettings')}
          </label>
        )}
        {requiredKeys.map((key) => (
          <Input
            key={key}
            type="password"
            autoComplete="new-password"
            aria-label={key}
            placeholder={key}
            value={secrets[key] ?? ''}
            disabled={busy || (!pending && keepSettings && canKeepSettings)}
            onChange={(event) =>
              setSecrets((old) => ({ ...old, [key]: event.target.value }))
            }
          />
        ))}
        {requiredKeys.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('managed.install.workspaceCredentials')}
          </p>
        )}
        <Select
          value={target}
          onValueChange={setTarget}
          disabled={busy || !!pending}
        >
          <SelectTrigger aria-label={t('managed.extensions.target')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['linux:x64', 'linux:arm64', 'darwin:arm64', 'darwin:x64'].map(
              (value) => (
                <SelectItem key={value} value={value}>
                  {value.replace(':', '/')}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
        {!editing && kind !== 'mcp' && (
          <Select
            value={updateId}
            onValueChange={(value) => {
              setUpdateId(value);
              const previous = catalog.extensions.find(
                (entry) => entry.pin.extensionId === value,
              );
              if (previous) setName(previous.manifest.name);
            }}
            disabled={busy || !!pending}
          >
            <SelectTrigger aria-label={t('managed.install.updateTarget')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">{t('managed.extensions.new')}</SelectItem>
              {catalog.extensions.map((entry) => (
                <SelectItem
                  key={entry.pin.extensionId}
                  value={entry.pin.extensionId}
                >
                  {entry.manifest.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {updateId !== 'new' && (
          <p className="text-sm text-muted-foreground">
            {t('managed.install.replacePackage')}
          </p>
        )}
        {editing?.inspection.mcpServers.some((entry) => entry.redacted) && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('managed.install.redacted')}
          </p>
        )}
        {previewMatches && (
          <div
            className="grid gap-2 rounded-md border p-3 text-sm"
            data-managed-package-preview
          >
            <strong>{preview.inspection.manifest.name}</strong>
            <p>
              {preview.inspection.manifest.components.join(', ')} ·{' '}
              {preview.inspection.manifest.target.platform}/
              {preview.inspection.manifest.target.arch}
            </p>
            {preview.inspection.skills.map((skill) => (
              <p key={skill.name}>
                {skill.name}: {skill.description}
              </p>
            ))}
            {preview.inspection.mcpServers.map((server) => (
              <p key={server.name}>{server.name}</p>
            ))}
            <ul className="max-h-40 overflow-auto text-xs">
              {preview.inspection.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            {preview.inspection.truncated && (
              <p>{t('managed.install.truncated')}</p>
            )}
            <code className="break-all text-xs">
              {preview.metadata.sourceDigest}
            </code>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!pending && (
            <Button
              variant="outline"
              disabled={
                busy ||
                (kind === 'mcp'
                  ? !name || (transport === 'stdio' ? !command : !url)
                  : !file)
              }
              onClick={() => void review()}
            >
              {t('managed.install.review')}
            </Button>
          )}
          <Button
            disabled={busy || blocked || (!pending && !previewMatches)}
            onClick={() => void install()}
          >
            {t(
              pending ? 'managed.extensions.retry' : 'managed.install.install',
            )}
          </Button>
          {pending && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const controller = new AbortController();
                request.current?.abort();
                request.current = controller;
                setBusy(true);
                void (async () => {
                  try {
                    const original = await management.lookupApplyOperation!(
                      sessionId,
                      pending.applyKey,
                      { clientId, signal: controller.signal },
                    );
                    controller.signal.throwIfAborted();
                    if (isManagedExtensionInstallActive(pending, original)) {
                      save(undefined);
                      setStatus('managed.install.complete');
                      onChanged();
                      props.onInstalled?.();
                      return undefined;
                    }
                    if (
                      original.operation &&
                      !['active', 'failed'].includes(original.operation.state)
                    )
                      throw new Error(
                        'The original operation still requires recovery.',
                      );
                  } catch (cause) {
                    if (
                      !(
                        cause instanceof JavaManagedAgentHttpError &&
                        cause.status === 404
                      )
                    )
                      throw cause;
                  }
                  return management.query(sessionId, {
                    clientId,
                    signal: controller.signal,
                  });
                })()
                  .then((current) => {
                    if (
                      !current ||
                      controller.signal.aborted ||
                      !mounted.current
                    )
                      return;
                    if (
                      current.operation &&
                      !['active', 'failed'].includes(current.operation.state)
                    )
                      throw new Error('Configuration is pending.');
                    save({
                      ...pending,
                      expectedConfigRevision: current.revision,
                      extensions: current.extensions,
                      applyKey: `${managedRequestId()}:apply`,
                      applySubmitted: false,
                      ...(current.selectionVersion === 2 ||
                      pending.selectionVersion === 2
                        ? {
                            selectionVersion: 2,
                            mcpAuthBindings: [
                              ...(current.mcpAuthBindings ?? []).filter(
                                (binding) =>
                                  !pending.pin ||
                                  !binding.serverId.startsWith(
                                    `${pending.pin.extensionId}:`,
                                  ),
                              ),
                              ...(pending.mcpAuthBindings ?? []).filter(
                                (binding) =>
                                  pending.pin &&
                                  binding.serverId.startsWith(
                                    `${pending.pin.extensionId}:`,
                                  ),
                              ),
                            ],
                          }
                        : {}),
                    });
                    setStatus('managed.install.reviewed');
                    setFailed(false);
                    onChanged();
                  })
                  .catch(() => {
                    if (!controller.signal.aborted && mounted.current)
                      setFailed(true);
                  })
                  .finally(() => {
                    if (mounted.current) setBusy(false);
                  });
              }}
            >
              {t('managed.install.reviewAgain')}
            </Button>
          )}
        </div>
        {pending && !pending.applySubmitted && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              save(undefined);
              source.current = undefined;
              setPreview(undefined);
              setSecrets({});
              setAuthorizationPins(undefined);
              setStatus('managed.install.discarded');
              setFailed(false);
            }}
          >
            {t('managed.install.discardDraft')}
          </Button>
        )}
        {authorizationPins && pending && provider.mcpOAuth && (
          <ManagedMcpOAuthPanel
            provider={provider}
            sessionId={sessionId}
            extensions={authorizationPins}
            onAuthorized={(binding) => {
              const next = {
                ...pending,
                selectionVersion: 2 as const,
                mcpAuthBindings: [
                  ...(pending.mcpAuthBindings ?? []).filter(
                    (entry) => entry.serverId !== binding.serverId,
                  ),
                  binding,
                ],
              };
              save(next);
              void install(next);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
