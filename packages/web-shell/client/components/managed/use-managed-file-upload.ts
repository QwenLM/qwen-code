import { useEffect, useMemo, useRef } from 'react';
import { fileReferenceInsertText } from '../../hooks/useAtMentionSources';
import type { FileUploadClient } from '../../hooks/useFileUpload';
import type { WebShellComposerTag } from '../../customization';
import type {
  ManagedAgentProvider,
  ManagedWorkspaceFileLocator,
} from './managed-agent-provider';

export interface ManagedUploadReference {
  version: 1;
  source: string;
  scopeRevision: string;
  path: string;
}

type UploadScope = ManagedWorkspaceFileLocator & {
  source: string;
  scopeRevision: string;
  maxUploadBytes: number;
};

export function useManagedFileUpload(
  provider: ManagedAgentProvider,
  clientId: string,
  scope: UploadScope | undefined,
) {
  const api = provider.workspaceFiles;
  const workspaceId = scope?.workspaceId;
  const cwdRelative = scope?.cwdRelative;
  const sessionId = scope?.sessionId;
  const source = scope?.source;
  const scopeRevision = scope?.scopeRevision;
  const targetKey =
    source && scopeRevision
      ? JSON.stringify([source, scopeRevision])
      : undefined;
  const currentTarget = useRef(targetKey);
  currentTarget.current = targetKey;
  useEffect(() => {
    currentTarget.current = targetKey;
    return () => {
      if (currentTarget.current === targetKey)
        currentTarget.current = undefined;
    };
  }, [targetKey]);
  const maxBytes = scope?.maxUploadBytes;
  return useMemo(() => {
    if (
      !api?.upload ||
      (!sessionId && (!workspaceId || !cwdRelative)) ||
      !source ||
      !scopeRevision ||
      !targetKey ||
      !maxBytes ||
      maxBytes <= 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes > 8 * 1024 * 1024
    )
      return undefined;
    const uploaded = new Map<string, ManagedUploadReference>();
    function assertCurrent(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (currentTarget.current !== targetKey)
        throw new Error('Workspace changed; select the file again.');
    }
    const client: FileUploadClient = {
      async uploadWorkspaceFile(request) {
        assertCurrent(request.signal);
        const data =
          request.data instanceof Blob
            ? request.data
            : new Blob([
                request.data instanceof Uint8Array
                  ? new Uint8Array(request.data).buffer
                  : request.data,
              ]);
        const uploadId = crypto.randomUUID();
        let result: Awaited<ReturnType<NonNullable<typeof api.upload>>>;
        try {
          result = await api.upload!(
            {
              ...(sessionId
                ? { sessionId }
                : { workspaceId: workspaceId!, cwdRelative: cwdRelative! }),
              path: request.path,
              expectedScopeRevision: scopeRevision,
              uploadId,
            },
            data,
            { clientId, signal: request.signal },
          );
        } catch (error) {
          assertCurrent(request.signal);
          const status =
            error && typeof error === 'object' && 'status' in error
              ? Number(error.status)
              : undefined;
          if ((status && status < 500) || !api.queryUpload) throw error;
          const recovered = await api.queryUpload(uploadId, {
            clientId,
            signal: request.signal,
          });
          if (recovered.state !== 'completed')
            throw new Error(
              recovered.state === 'pending'
                ? 'Upload outcome is not confirmed. Check the Workspace files before trying again.'
                : 'The file could not be uploaded. Try again.',
            );
          result = recovered;
        }
        assertCurrent(request.signal);
        if (
          result.uploadId !== uploadId ||
          result.path !== request.path ||
          result.sizeBytes !== data.size ||
          result.scopeRevision !== scopeRevision ||
          !/^[a-f0-9]{64}$/.test(result.sha256)
        )
          throw new Error('The uploaded file could not be confirmed.');
        uploaded.set(result.path, {
          version: 1,
          source,
          scopeRevision,
          path: result.path,
        });
        return {
          kind: 'file_upload',
          path: result.path,
          sizeBytes: result.sizeBytes,
          hash: `sha256:${result.sha256}`,
        };
      },
    };
    return {
      client,
      targetKey,
      maxBytes,
      createReference(path: string): WebShellComposerTag {
        assertCurrent();
        const managedUpload = uploaded.get(path);
        if (!managedUpload) throw new Error('The upload has not completed.');
        const serialized = fileReferenceInsertText(path).trim();
        return {
          id: `file:${serialized}`,
          kind: 'file',
          value: path,
          serialized,
          metadata: { fileKind: 'file', filePath: path, managedUpload },
        };
      },
    };
  }, [
    api,
    clientId,
    workspaceId,
    cwdRelative,
    sessionId,
    source,
    scopeRevision,
    maxBytes,
    targetKey,
  ]);
}
