import { useEffect, useMemo, useRef, useState } from 'react';
import type { AtMentionWorkspaceActions } from '../../hooks/useAtMentionSources';
import type { ComposerSubmitMetadata } from '../../hooks/useComposerCore';
import type { WebShellComposerTag } from '../../customization';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type { PromptFile } from '../../adapters/promptTypes';
import {
  useManagedFileUpload,
  type ManagedUploadReference,
} from './use-managed-file-upload';

interface Snapshot {
  version: 1;
  source: string;
  scopeRevision: string;
  path: string;
  name: string;
  text: string;
  sha256: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Some deployments cannot serve Workspace file references at all: the runtime
// broker's CLI predates the workspaceFiles handshake, or the storage kind does
// not support references. The mount probe treats that as an absent capability
// and reports nothing; a refusal later in the Session still surfaces, because
// the same code also covers a broker that failed mid-request.
function isFileAccessUnsupported(error: unknown): boolean {
  return object(error).code === 'workspace_files_unsupported';
}

export function useManagedFileReferences(
  provider: ManagedAgentProvider,
  clientId: string,
  workspace:
    | {
        workspaceId: string;
        cwdRelative: string;
        contextRevision?: number;
        state?: string;
      }
    | undefined,
  sessionId = 'new',
) {
  const workspaceId = workspace?.workspaceId;
  const cwdRelative = workspace?.cwdRelative;
  const source = JSON.stringify([
    provider.storageKey,
    clientId,
    workspaceId,
    cwdRelative,
    workspace?.contextRevision,
    workspace?.state,
    sessionId,
  ]);
  const active = useRef(false);
  const currentSource = useRef(source);
  currentSource.current = source;
  const [ready, setReady] = useState<string>();
  const [uploadScope, setUploadScope] = useState<{
    source: string;
    scopeRevision: string;
    maxUploadBytes: number;
  }>();
  const pendingReads = useRef(new Map<string, number>());
  const [busySource, setBusySource] = useState<string>();
  const [failure, setFailure] = useState<{ source: string; message: string }>();
  const api = provider.workspaceFiles;
  const actions = useMemo<AtMentionWorkspaceActions | undefined>(() => {
    if (
      !api ||
      !workspaceId ||
      !cwdRelative ||
      (workspace?.state && workspace.state !== 'ready')
    )
      return undefined;
    let revision: string | undefined;
    function report(error: unknown): never {
      if (active.current && currentSource.current === source)
        setFailure({
          source,
          message: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    async function query(
      directory: string,
      query: string,
      signal?: AbortSignal,
    ) {
      try {
        const result = await api!.query(
          {
            ...(sessionId === 'new'
              ? { workspaceId: workspaceId!, cwdRelative: cwdRelative! }
              : { sessionId }),
            directory,
            query,
          },
          { clientId, signal },
        );
        if (!active.current || currentSource.current !== source)
          throw new Error('Workspace changed; select the file again.');
        revision = result.scopeRevision;
        setUploadScope({
          source,
          scopeRevision: result.scopeRevision,
          maxUploadBytes: result.maxUploadBytes ?? 0,
        });
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        return report(error);
      }
    }
    return {
      scopeKey: source,
      filesOnly: true,
      onFileReferenceDiscarded() {
        if (active.current && currentSource.current === source)
          setFailure({
            source,
            message: 'Draft changed; select the file again.',
          });
      },
      async listDirectory(directory, options) {
        const page = await query(directory, '', options?.signal);
        return {
          kind: 'list',
          path: directory,
          entries: page.entries.map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            ignored: false,
          })),
          truncated: page.truncated,
        };
      },
      async searchWorkspaceFiles(search, signal) {
        return (await query('.', search, signal)).entries.map(
          (entry) => entry.path,
        );
      },
      async prepareFileReference(tag: WebShellComposerTag) {
        pendingReads.current.set(
          source,
          (pendingReads.current.get(source) ?? 0) + 1,
        );
        setBusySource(source);
        try {
          const path = object(tag.metadata)['filePath'];
          if (
            typeof path !== 'string' ||
            object(tag.metadata)['fileKind'] !== 'file'
          )
            throw new Error('Choose a Workspace text file.');
          if (!revision) await query('.', '');
          const snapshot = await api.read(
            {
              ...(sessionId === 'new'
                ? { workspaceId, cwdRelative }
                : { sessionId }),
              path,
              expectedScopeRevision: revision!,
            },
            { clientId },
          );
          if (!active.current || currentSource.current !== source)
            throw new Error('Workspace changed; select the file again.');
          setFailure(undefined);
          const managedFile: Snapshot = {
            version: 1,
            source,
            scopeRevision: snapshot.scopeRevision,
            path: snapshot.path,
            name: snapshot.name,
            text: snapshot.text,
            sha256: snapshot.sha256,
          };
          return {
            ...tag,
            metadata: { fileKind: 'file', filePath: path, managedFile },
          };
        } catch (error) {
          revision = undefined;
          return report(error);
        } finally {
          const remaining = (pendingReads.current.get(source) ?? 1) - 1;
          if (remaining) pendingReads.current.set(source, remaining);
          else {
            pendingReads.current.delete(source);
            if (active.current && currentSource.current === source)
              setBusySource((current) =>
                current === source ? undefined : current,
              );
          }
        }
      },
    };
  }, [
    api,
    workspaceId,
    cwdRelative,
    source,
    clientId,
    workspace?.state,
    sessionId,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    active.current = true;
    setReady(undefined);
    setFailure(undefined);
    if (actions?.listDirectory)
      void actions
        .listDirectory('.', { signal: controller.signal })
        .then(() => {
          if (!controller.signal.aborted) setReady(source);
        })
        .catch((error: unknown) => {
          // The probe is the only path that treats this code as an absent
          // capability. Clearing the failure it just recorded keeps the
          // composer clean; the same code on a later read still surfaces.
          if (!controller.signal.aborted && isFileAccessUnsupported(error))
            setFailure(undefined);
        });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [actions, source]);

  const uploadTarget = useManagedFileUpload(
    provider,
    clientId,
    ready === source &&
      uploadScope?.source === source &&
      workspaceId &&
      cwdRelative
      ? {
          ...uploadScope,
          ...(sessionId === 'new'
            ? { workspaceId, cwdRelative }
            : { sessionId }),
        }
      : undefined,
  );

  function assertCurrent() {
    if (!active.current || currentSource.current !== source)
      throw new Error('Workspace changed; select the file again.');
  }

  async function prepareInput(
    text: string,
    files: readonly PromptFile[] = [],
    metadata?: ComposerSubmitMetadata,
  ) {
    if ((pendingReads.current.get(source) ?? 0) > 0)
      throw new Error(
        'Wait for the selected file to finish loading before sending.',
      );
    const selected: Snapshot[] = [];
    const uploaded: ManagedUploadReference[] = [];
    for (const annotation of metadata?.inputAnnotations ?? []) {
      if (
        annotation.type !== 'reference' ||
        annotation.reference.kind !== 'file'
      )
        continue;
      const details = object(annotation.reference.metadata);
      const upload = object(details['managedUpload']);
      if (upload['version'] === 1) {
        if (
          upload['source'] !== source ||
          typeof upload['scopeRevision'] !== 'string' ||
          typeof upload['path'] !== 'string' ||
          upload['path'] !== details['filePath'] ||
          !upload['path'] ||
          upload['path']
            .split('/')
            .some((part) => !part || part === '.' || part === '..')
        )
          throw new Error('Workspace changed; select the file again.');
        if (!uploaded.some((item) => item.path === upload['path']))
          uploaded.push(upload as unknown as ManagedUploadReference);
        continue;
      }
      const item = object(details['managedFile']);
      if (
        item['version'] !== 1 ||
        item['source'] !== source ||
        typeof item['scopeRevision'] !== 'string' ||
        typeof item['path'] !== 'string' ||
        typeof item['name'] !== 'string' ||
        typeof item['text'] !== 'string' ||
        typeof item['sha256'] !== 'string'
      )
        throw new Error(
          'Workspace changed or file reference expired; select the file again.',
        );
      if (!selected.some((snapshot) => snapshot.path === item['path']))
        selected.push(item as unknown as Snapshot);
    }
    if (!selected.length && !uploaded.length)
      return { text, files: [...files] };
    if (!api || !workspaceId || !cwdRelative)
      throw new Error('Workspace file access is unavailable.');
    const scope = await api.query(
      {
        ...(sessionId === 'new' ? { workspaceId, cwdRelative } : { sessionId }),
        directory: '.',
        query: '',
      },
      { clientId },
    );
    if (
      !active.current ||
      currentSource.current !== source ||
      [...selected, ...uploaded].some(
        (item) => item.scopeRevision !== scope.scopeRevision,
      )
    )
      throw new Error('Workspace changed; select the file again.');
    const attached = [...files];
    const mapping: string[] = [];
    for (const snapshot of selected) {
      // Catch draft-storage corruption after the server validated the read.
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(snapshot.text),
          ),
        ),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      if (digest !== snapshot.sha256)
        throw new Error('File snapshot is invalid; select the file again.');
      let name = snapshot.name;
      let index = 1;
      while (attached.some((file) => file.name === name))
        name = `reference-${index++}-${Array.from(snapshot.name).slice(-100).join('')}`;
      attached.push({ name, media_type: 'text/plain', text: snapshot.text });
      mapping.push(
        `${JSON.stringify(snapshot.path)} → ${JSON.stringify(name)}`,
      );
    }
    assertCurrent();
    const context = [
      ...(selected.length
        ? [
            `Workspace files (relative path → attachment):\n${mapping.join('\n')}`,
          ]
        : []),
      ...(uploaded.length
        ? [
            `Uploaded Workspace files (paths relative to the working directory):\n${uploaded.map((item) => JSON.stringify(item.path)).join('\n')}`,
          ]
        : []),
    ];
    return {
      text: `${text}\n\n${context.join('\n\n')}`,
      files: attached,
    };
  }
  return {
    actions: ready === source ? actions : undefined,
    uploadTarget,
    busy: busySource === source && (pendingReads.current.get(source) ?? 0) > 0,
    prepareInput,
    assertCurrent,
    error: failure?.source === source ? failure.message : undefined,
  };
}
