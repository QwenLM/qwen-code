import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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
  ManagedExtensionSnapshot,
  ManagedRuntimeSkillCandidates,
  ManagedRuntimeSkillSnapshot,
} from './managed-extension-types';
import {
  continueManagedExtensionInstall,
  createManagedExtensionInstall,
  parseManagedExtensionInstall,
  isManagedExtensionInstallActive,
  type ManagedExtensionInstallCommand,
} from './managed-extension-install';
import { getManagedClientId } from './managed-session-storage';

export function ManagedRuntimeSkillsImporter({
  provider,
  workspaceId,
  sessionId,
  catalog,
  snapshot,
  onChanged,
}: {
  provider: ManagedAgentProvider;
  workspaceId: string;
  sessionId: string;
  catalog: ManagedExtensionCatalog;
  snapshot: ManagedExtensionSnapshot;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = provider.extensions;
  const [candidates, setCandidates] = useState<ManagedRuntimeSkillCandidates>();
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<ManagedRuntimeSkillSnapshot>();
  const [pending, setPending] = useState<ManagedExtensionInstallCommand>();
  const [target, setTarget] = useState('linux:x64');
  const [updateId, setUpdateId] = useState('new');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const clientId = getManagedClientId(
    api?.storageScope ?? 'managed-runtime-skills',
  );
  const storageKey = api?.storageScope
    ? `managed-runtime-skill-install:${api.storageScope}:${workspaceId}:${sessionId}`
    : undefined;
  const save = (value: ManagedExtensionInstallCommand | undefined) => {
    if (!mounted.current) return;
    setPending(value);
    if (storageKey)
      try {
        if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
  };
  useEffect(() => {
    mounted.current = true;
    setPending(undefined);
    setPreview(undefined);
    setCandidates(undefined);
    setSelected('');
    setStatus('');
    setFailed(false);
    setBusy(false);
    if (storageKey)
      try {
        const raw = sessionStorage.getItem(storageKey);
        const value = raw
          ? parseManagedExtensionInstall(raw, workspaceId, sessionId)
          : undefined;
        if (value?.runtimeSnapshot) {
          setPending(value);
          setStatus('managed.install.savedNotApplied');
        } else if (raw) sessionStorage.removeItem(storageKey);
      } catch {
        /* Storage is optional. */
      }
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [storageKey, workspaceId, sessionId, provider]);
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const abort = new AbortController();
    request.current?.abort();
    request.current = abort;
    setBusy(true);
    setFailed(false);
    try {
      await action(abort.signal);
    } catch {
      if (!abort.signal.aborted && mounted.current) {
        setFailed(true);
        setStatus('managed.runtimeSkills.failed');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (
    !api?.runtimeSkillCandidates ||
    !api.runtimeSkillSnapshot ||
    !api.importRuntimeSkill ||
    !catalog.selfService?.canPublish ||
    !snapshot.selfService?.canApply ||
    !snapshot.selfService.runtimeSkillImportSupported
  )
    return null;
  const blocked =
    !!snapshot.operation &&
    !['active', 'failed'].includes(snapshot.operation.state);
  return (
    <Card data-managed-runtime-skills>
      <CardHeader>
        <CardTitle>{t('managed.runtimeSkills.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {t('managed.runtimeSkills.description')}
        </p>
        {status && (
          <Alert variant={failed ? 'destructive' : 'default'}>
            <AlertDescription role="status">{t(status)}</AlertDescription>
          </Alert>
        )}
        {!pending && (
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async (signal) => {
                  const result = await api.runtimeSkillCandidates!(sessionId, {
                    clientId,
                    signal,
                  });
                  if (result.sessionId !== sessionId)
                    throw new Error('Runtime Skill target changed.');
                  if (!signal.aborted) {
                    setCandidates(result);
                    setSelected('');
                    setPreview(undefined);
                    setStatus(
                      result.candidates.length
                        ? ''
                        : 'managed.runtimeSkills.empty',
                    );
                  }
                })
              }
            >
              {t('managed.runtimeSkills.scan')}
            </Button>
            {candidates?.candidates.map((candidate) => (
              <label
                key={candidate.path}
                className="grid gap-1 rounded-md border p-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`runtime-skill-${clientId}`}
                    value={candidate.path}
                    checked={selected === candidate.path}
                    disabled={busy || !candidate.compatible}
                    onChange={() => {
                      setSelected(candidate.path);
                      setPreview(undefined);
                    }}
                  />
                  <strong>{candidate.name}</strong>
                  {candidate.shadowed && (
                    <Badge variant="outline">
                      {t('managed.runtimeSkills.shadowed')}
                    </Badge>
                  )}
                </span>
                <span>{candidate.description}</span>
                <code className="break-all text-xs">{candidate.path}</code>
                {!candidate.compatible && (
                  <span>{t('managed.runtimeSkills.incompatible')}</span>
                )}
              </label>
            ))}
            <Select
              value={target}
              onValueChange={(value) => {
                setTarget(value);
                setPreview(undefined);
              }}
              disabled={busy}
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
            <Button
              variant="outline"
              disabled={busy || !selected || !candidates}
              onClick={() =>
                void run(async (signal) => {
                  const candidate = candidates!.candidates.find(
                    (entry) => entry.path === selected,
                  )!;
                  const [platform, arch] = target.split(':') as [
                    'linux' | 'darwin',
                    'arm64' | 'x64',
                  ];
                  const result = await api.runtimeSkillSnapshot!(
                    sessionId,
                    {
                      owner: candidates!.owner,
                      path: candidate.path,
                      digest: candidate.digest,
                      target: { platform, arch },
                    },
                    { clientId, signal },
                  );
                  if (
                    result.sessionId !== sessionId ||
                    result.owner.bindingId !== candidates!.owner.bindingId ||
                    result.owner.generation !== candidates!.owner.generation
                  )
                    throw new Error('Runtime Skill owner changed.');
                  if (!signal.aborted) setPreview(result);
                })
              }
            >
              {t('managed.install.review')}
            </Button>
          </>
        )}
        {preview && (
          <div className="grid gap-2 rounded-md border p-3 text-sm">
            <strong>{preview.inspection.manifest.name}</strong>
            <ul className="max-h-40 overflow-auto text-xs">
              {preview.inspection.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
            {preview.inspection.truncated && (
              <span>{t('managed.install.truncated')}</span>
            )}
            <Select
              value={updateId}
              onValueChange={setUpdateId}
              disabled={busy || !!pending}
            >
              <SelectTrigger aria-label={t('managed.install.updateTarget')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">
                  {t('managed.extensions.new')}
                </SelectItem>
                {catalog.extensions
                  .filter(
                    (entry) =>
                      entry.manifest.name ===
                        preview.inspection.manifest.name &&
                      entry.manifest.components.includes('skills'),
                  )
                  .map((entry) => (
                    <SelectItem
                      key={entry.pin.extensionId}
                      value={entry.pin.extensionId}
                    >
                      {entry.manifest.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button
          disabled={busy || blocked || (!preview && !pending)}
          onClick={() =>
            void run(async (signal) => {
              let command = pending;
              if (!command) {
                if (!preview) return;
                const current = await api.query(sessionId, {
                  clientId,
                  signal,
                });
                signal.throwIfAborted();
                if (current.revision !== snapshot.revision)
                  throw new Error('Session configuration changed.');
                const runtimeSnapshot = {
                  sessionId: preview.sessionId,
                  owner: preview.owner,
                  operationId: preview.operationId,
                  preparationId: preview.preparationId,
                  sourceDigest: preview.sourceDigest,
                  byteLength: preview.byteLength,
                  target: preview.target,
                };
                command = createManagedExtensionInstall(
                  {
                    workspaceId,
                    sessionId,
                    metadata: {
                      sourceKind: 'skill',
                      target: preview.target,
                      sourceDigest: preview.sourceDigest,
                      compilerVersion:
                        preview.inspection.manifest.compilerVersion === 2
                          ? 2
                          : 1,
                    },
                    expectedSettingsRevision: 0,
                    settingsKeys: [],
                    runtimeSnapshot,
                    ...(updateId === 'new' ? {} : { extensionId: updateId }),
                  },
                  current,
                );
                save(command);
              }
              let completedCommand = command;
              const result = await continueManagedExtensionInstall(
                api,
                command,
                undefined,
                undefined,
                { clientId, signal },
                (value) => {
                  completedCommand = value;
                  save(value);
                  setStatus(`managed.install.stage.${value.stage}`);
                },
              );
              if (signal.aborted) return;
              if (isManagedExtensionInstallActive(completedCommand, result)) {
                save(undefined);
                setPreview(undefined);
                setStatus('managed.install.complete');
              } else setStatus('managed.install.savedNotApplied');
              onChanged();
            })
          }
        >
          {t(pending ? 'managed.extensions.retry' : 'managed.install.install')}
        </Button>
        {pending && !pending.applySubmitted && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              save(undefined);
              setPreview(undefined);
              setCandidates(undefined);
              setSelected('');
              setStatus('managed.install.discarded');
              setFailed(false);
            }}
          >
            {t('managed.install.discardDraft')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
