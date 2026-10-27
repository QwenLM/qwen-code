import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, RefreshCwIcon } from 'lucide-react';
import { useOptionalWorkspace } from '../../daemon-react-sdk';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Alert, AlertDescription } from '../ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '../ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedExtensionCatalog,
  ManagedExtensionPin,
  ManagedExtensionSelection,
  ManagedExtensionSnapshot,
  ManagedExtensionManifest,
} from './managed-extension-types';
import { isManagedExtensionPins } from './managed-extension-types';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';

export interface ManagedExtensionsManagerPageProps {
  provider: ManagedAgentProvider;
  workspaceId?: string;
  sessionId?: string;
  onClose: () => void;
}

function samePin(a: ManagedExtensionPin, b: ManagedExtensionPin) {
  return JSON.stringify(a) === JSON.stringify(b);
}
interface PendingApply {
  selection: ManagedExtensionSelection;
  key: string;
}

export function ManagedExtensionsManagerPage({
  provider,
  workspaceId,
  sessionId,
  onClose,
}: ManagedExtensionsManagerPageProps) {
  const { t } = useI18n();
  const daemon = useOptionalWorkspace();
  const management = provider.extensions;
  const [catalog, setCatalog] = useState<ManagedExtensionCatalog>();
  const [snapshot, setSnapshot] = useState<ManagedExtensionSnapshot>();
  const [selection, setSelection] = useState<ManagedExtensionPin[]>([]);
  const [pending, setPending] = useState<PendingApply>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [source, setSource] = useState('');
  const [ref, setRef] = useState('');
  const [target, setTarget] = useState('linux:x64');
  const [updateId, setUpdateId] = useState('new');
  const [settings, setSettings] = useState<{
    id: string;
    revision: number;
    entries: Array<{ key: string; value: string }>;
  }>();
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const publication = useRef<{ identity: string; key: string } | undefined>(
    undefined,
  );
  const settingsSubmission = useRef<
    { identity: string; key: string } | undefined
  >(undefined);
  const clientId = getManagedClientId(
    management?.storageScope ?? 'managed-extensions',
  );
  const storageKey =
    management?.storageScope && workspaceId && sessionId
      ? `managed-extension-apply:${management.storageScope}:${workspaceId}:${sessionId}`
      : undefined;
  const blocked =
    !!snapshot?.operation &&
    (!['active', 'failed'].includes(snapshot.operation.state) ||
      (snapshot.operation.mode === 'recoverPrevious' &&
        snapshot.operation.state === 'failed'));

  const load = useCallback(
    async (signal: AbortSignal, current: number) => {
      if (!management || !workspaceId || !sessionId) return;
      const [nextCatalog, nextSnapshot] = await Promise.all([
        management.list(workspaceId, { clientId, signal }),
        management.query(sessionId, { clientId, signal }),
      ]);
      if (current !== generation.current || signal.aborted) return;
      setCatalog(nextCatalog);
      setSnapshot(nextSnapshot);
      setSelection(
        nextSnapshot.operation
          ? nextSnapshot.requestedExtensions
          : nextSnapshot.extensions,
      );
    },
    [management, workspaceId, sessionId, clientId],
  );

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    setCatalog(undefined);
    setSnapshot(undefined);
    setSelection([]);
    setSettings(undefined);
    setPending(undefined);
    setError(false);
    publication.current = undefined;
    settingsSubmission.current = undefined;
    setBusy(true);
    if (storageKey) {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) {
          const saved = JSON.parse(raw) as PendingApply;
          if (
            saved.key &&
            isManagedExtensionPins(saved.selection?.extensions) &&
            Number.isSafeInteger(saved.selection.expectedConfigRevision)
          )
            setPending(saved);
          else sessionStorage.removeItem(storageKey);
        }
      } catch {
        /* Storage is optional. */
      }
    }
    void load(controller.signal, current)
      .catch(() => {
        if (!controller.signal.aborted && current === generation.current)
          setError(true);
      })
      .finally(() => {
        if (current === generation.current) setBusy(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
      generation.current = current + 1;
    };
  }, [load, storageKey]);

  const run = async (
    action: (signal: AbortSignal) => Promise<void>,
    refresh = true,
  ) => {
    if (busy) return;
    const current = generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError(false);
    try {
      await action(controller.signal);
      if (
        refresh &&
        !controller.signal.aborted &&
        current === generation.current
      )
        await load(controller.signal, current);
    } catch {
      if (!controller.signal.aborted && current === generation.current)
        setError(true);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const apply = () =>
    run(async (signal) => {
      if (!management || !sessionId || !snapshot) return;
      const input = pending ?? {
        key: managedRequestId(),
        selection: {
          expectedConfigRevision: snapshot.revision,
          extensions: selection,
        },
      };
      setPending(input);
      if (storageKey) {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(input));
        } catch {
          /* Storage is optional. */
        }
      }
      const clearPending = () => {
        setPending(undefined);
        if (storageKey) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            /* Storage is optional. */
          }
        }
      };
      const current = generation.current;
      try {
        await management.apply(sessionId, input.selection, {
          clientId,
          signal,
          idempotencyKey: input.key,
        });
      } catch (cause) {
        if (
          !signal.aborted &&
          current === generation.current &&
          cause instanceof JavaManagedAgentHttpError &&
          cause.status === 409 &&
          cause.code === 'extension_config_revision_conflict'
        ) {
          clearPending();
          await load(signal, current);
        }
        throw cause;
      }
      if (!signal.aborted && current === generation.current) clearPending();
    });

  return (
    <section
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4"
      aria-label={t('managed.extensions.title')}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {t('managed.extensions.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('managed.extensions.description')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.refresh')}
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            <RefreshCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('common.back')}
            onClick={onClose}
          >
            <ArrowLeftIcon />
          </Button>
        </div>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {t('managed.extensions.failedRequest')}
          </AlertDescription>
        </Alert>
      )}
      {!workspaceId || !sessionId ? (
        <p>{t('managed.extensions.selectSession')}</p>
      ) : !management ||
        catalog?.supported === false ||
        snapshot?.supported === false ? (
        <p>{t('managed.extensions.unsupported')}</p>
      ) : (
        <>
          {snapshot?.operation && (
            <div role="status">
              <Badge>
                {t(`managed.extensions.${snapshot.operation.state}`)}
              </Badge>{' '}
              <span className="text-sm">r{snapshot.revision}</span>
              {blocked && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void run(async (signal) => {
                      await management.resume(
                        sessionId,
                        snapshot.operation!.operationId,
                        false,
                        { clientId, signal },
                      );
                    })
                  }
                >
                  {t('managed.extensions.continue')}
                </Button>
              )}
              {snapshot.operation.state === 'recovery_required' && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() =>
                    void run(async (signal) => {
                      await management.resume(
                        sessionId,
                        snapshot.operation!.operationId,
                        true,
                        { clientId, signal },
                      );
                    })
                  }
                >
                  {t('managed.extensions.recover')}
                </Button>
              )}
            </div>
          )}
          <div className="grid gap-3">
            {!catalog?.extensions.length && (
              <p className="text-muted-foreground">
                {t('managed.extensions.empty')}
              </p>
            )}
            {catalog?.extensions.map((entry) => {
              const chosen = selection.find(
                (pin) => pin.extensionId === entry.pin.extensionId,
              );
              const active = snapshot?.extensions.find(
                (pin) => pin.extensionId === entry.pin.extensionId,
              );
              return (
                <Card key={entry.pin.extensionId}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        aria-label={entry.manifest.name}
                        checked={!!chosen}
                        disabled={
                          busy ||
                          blocked ||
                          !!pending ||
                          (!chosen && selection.length >= 32)
                        }
                        onChange={(event) =>
                          setSelection((old) =>
                            event.target.checked &&
                            (old.length < 32 ||
                              old.some(
                                (pin) =>
                                  pin.extensionId === entry.pin.extensionId,
                              ))
                              ? [
                                  ...old.filter(
                                    (pin) =>
                                      pin.extensionId !== entry.pin.extensionId,
                                  ),
                                  entry.pin,
                                ]
                              : event.target.checked
                                ? old
                                : old.filter(
                                    (pin) =>
                                      pin.extensionId !== entry.pin.extensionId,
                                  ),
                          )
                        }
                      />
                      {entry.manifest.name}
                      <Badge variant="secondary">
                        {active && chosen && samePin(active, chosen)
                          ? t('managed.extensions.active')
                          : chosen
                            ? t('managed.extensions.pending')
                            : t('managed.extensions.installed')}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-2 text-sm">
                    <p>
                      {entry.manifest.version} ·{' '}
                      {entry.manifest.target.platform}/
                      {entry.manifest.target.arch} ·{' '}
                      {entry.manifest.components.join(', ')}
                    </p>
                    <code className="break-all text-xs text-muted-foreground">
                      {entry.pin.packageDigest}
                    </code>
                    <div className="flex gap-2">
                      {chosen &&
                        chosen.packageRevision !==
                          entry.pin.packageRevision && (
                          <Button
                            disabled={busy || blocked || !!pending}
                            variant="outline"
                            onClick={() =>
                              setSelection((old) =>
                                old.map((pin) =>
                                  pin.extensionId === entry.pin.extensionId
                                    ? {
                                        ...entry.pin,
                                        ...(pin.settingsRevision === undefined
                                          ? {}
                                          : {
                                              settingsRevision:
                                                pin.settingsRevision,
                                            }),
                                      }
                                    : pin,
                                ),
                              )
                            }
                          >
                            {t('managed.extensions.update')}
                          </Button>
                        )}
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async (signal) => {
                            const current = await management.settings(
                              workspaceId,
                              entry.pin.extensionId,
                              { clientId, signal },
                            );
                            if (!signal.aborted)
                              setSettings({
                                id: entry.pin.extensionId,
                                revision: current.settingsRevision,
                                entries: current.configuredKeys.map((key) => ({
                                  key,
                                  value: '',
                                })),
                              });
                          }, false)
                        }
                      >
                        {t('managed.extensions.settings')}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <Button
            disabled={busy || !snapshot || blocked || !snapshot.supported}
            onClick={() => void apply()}
          >
            {pending
              ? t('managed.extensions.retry')
              : t('managed.extensions.apply')}
          </Button>
          <Card>
            <CardHeader>
              <CardTitle>{t('managed.extensions.publish')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Input
                aria-label={t('managed.extensions.source')}
                placeholder={t('managed.extensions.source')}
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              <Input
                aria-label={t('managed.extensions.ref')}
                placeholder={t('managed.extensions.ref')}
                value={ref}
                onChange={(event) => setRef(event.target.value)}
              />
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label={t('managed.extensions.target')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'linux:x64',
                    'linux:arm64',
                    'darwin:arm64',
                    'darwin:x64',
                  ].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value.replace(':', '/')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={updateId} onValueChange={setUpdateId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">
                    {t('managed.extensions.new')}
                  </SelectItem>
                  {catalog?.extensions.map((entry) => (
                    <SelectItem
                      key={entry.pin.extensionId}
                      value={entry.pin.extensionId}
                    >
                      {t('managed.extensions.update')}: {entry.manifest.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!daemon && (
                <p className="text-sm text-muted-foreground">
                  {t('managed.extensions.localPublisher')}
                </p>
              )}
              <Button
                disabled={busy || !daemon || !source.trim()}
                onClick={() =>
                  void run(async (signal) => {
                    const [platform, arch] = target.split(':') as [
                      'linux' | 'darwin',
                      'arm64' | 'x64',
                    ];
                    const prepared = await daemon!.client.prepareManagedPackage(
                      {
                        source: source.trim(),
                        ...(ref ? { ref } : {}),
                        target: { platform, arch },
                        consent: true,
                      },
                      { signal },
                    );
                    const archive =
                      await daemon!.client.readPreparedManagedPackage(
                        prepared.archiveUrl,
                        signal,
                      );
                    const identity = JSON.stringify([
                      workspaceId,
                      updateId,
                      prepared.packageDigest,
                      prepared.manifest,
                    ]);
                    if (publication.current?.identity !== identity)
                      publication.current = {
                        identity,
                        key: managedRequestId(),
                      };
                    await management.publish(
                      workspaceId,
                      updateId === 'new' ? undefined : updateId,
                      prepared.packageDigest,
                      prepared.manifest as ManagedExtensionManifest,
                      archive,
                      {
                        clientId,
                        signal,
                        idempotencyKey: publication.current.key,
                      },
                    );
                    publication.current = undefined;
                  })
                }
              >
                {t('managed.extensions.publish')}
              </Button>
            </CardContent>
          </Card>
        </>
      )}
      {settings && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSettings(undefined);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('managed.extensions.settings')}</DialogTitle>
              <DialogDescription>
                {t('managed.extensions.settingsDescription')}
              </DialogDescription>
            </DialogHeader>
            {settings.entries.map((entry, index) => (
              <div className="flex gap-2" key={index}>
                <Input
                  aria-label={t('managed.extensions.key')}
                  value={entry.key}
                  onChange={(event) =>
                    setSettings(
                      (old) =>
                        old && {
                          ...old,
                          entries: old.entries.map((value, position) =>
                            position === index
                              ? { ...value, key: event.target.value }
                              : value,
                          ),
                        },
                    )
                  }
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  aria-label={t('managed.extensions.value')}
                  value={entry.value}
                  onChange={(event) =>
                    setSettings(
                      (old) =>
                        old && {
                          ...old,
                          entries: old.entries.map((value, position) =>
                            position === index
                              ? { ...value, value: event.target.value }
                              : value,
                          ),
                        },
                    )
                  }
                />
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                setSettings(
                  (old) =>
                    old && {
                      ...old,
                      entries: [...old.entries, { key: '', value: '' }],
                    },
                )
              }
            >
              {t('managed.extensions.addSetting')}
            </Button>
            <DialogFooter>
              {settings.revision > 0 && (
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    blocked ||
                    !!pending ||
                    (selection.length >= 32 &&
                      !selection.some((pin) => pin.extensionId === settings.id))
                  }
                  onClick={() => {
                    const entry = catalog?.extensions.find(
                      (item) => item.pin.extensionId === settings.id,
                    );
                    if (!entry) return;
                    setSelection((old) =>
                      old.length >= 32 &&
                      !old.some((pin) => pin.extensionId === settings.id)
                        ? old
                        : [
                            ...old.filter(
                              (pin) => pin.extensionId !== settings.id,
                            ),
                            {
                              ...(old.find(
                                (pin) => pin.extensionId === settings.id,
                              ) ?? entry.pin),
                              settingsRevision: settings.revision,
                            },
                          ],
                    );
                    setSettings(undefined);
                  }}
                >
                  {t('managed.extensions.useSettings')} {settings.revision}
                </Button>
              )}
              <Button
                disabled={
                  busy ||
                  settings.entries.some(
                    (entry) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key),
                  ) ||
                  new Set(settings.entries.map((entry) => entry.key)).size !==
                    settings.entries.length
                }
                onClick={() =>
                  void run(async (signal) => {
                    const identity = JSON.stringify([
                      workspaceId,
                      settings.id,
                      settings.revision,
                      settings.entries,
                    ]);
                    if (settingsSubmission.current?.identity !== identity)
                      settingsSubmission.current = {
                        identity,
                        key: managedRequestId(),
                      };
                    const saved = await management!.saveSettings(
                      workspaceId!,
                      settings.id,
                      settings.revision,
                      Object.fromEntries(
                        settings.entries.map((entry) => [
                          entry.key,
                          entry.value,
                        ]),
                      ),
                      {
                        clientId,
                        signal,
                        idempotencyKey: settingsSubmission.current.key,
                      },
                    );
                    settingsSubmission.current = undefined;
                    if (!signal.aborted) {
                      setSelection((old) =>
                        old.map((pin) =>
                          pin.extensionId === settings.id
                            ? { ...pin, settingsRevision: saved.revision }
                            : pin,
                        ),
                      );
                      setSettings(undefined);
                    }
                  }, false)
                }
              >
                {t('managed.extensions.saveSettings')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
