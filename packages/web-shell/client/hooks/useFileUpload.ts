/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonWorkspaceFileUploadRequest,
  DaemonWorkspaceFileUploadResult,
} from '@qwen-code/sdk/daemon';

/**
 * Minimal structural client for uploads. Both `DaemonClient`
 * (legacy-primary) and `WorkspaceDaemonClient` (workspace-qualified) satisfy
 * it; the caller resolves the correct target before constructing the hook.
 */
export interface FileUploadClient {
  uploadWorkspaceFile(
    req: DaemonWorkspaceFileUploadRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceFileUploadResult>;
}

export type FileUploadStatus = 'pending' | 'uploading' | 'done' | 'error';

/** Machine-readable failure codes; the render site localizes them. */
export type FileUploadErrorCode = 'tooLarge' | 'noDaemon' | 'tooManyFiles';

export interface FileUploadItem {
  id: string;
  file: File;
  /** Requested relative path in the target workspace. */
  targetPath: string;
  status: FileUploadStatus;
  /** 0–1. */
  progress: number;
  /** Set for locally classified failures; localized at the render site. */
  errorCode?: FileUploadErrorCode;
  /** Raw failure message (server-side errors). */
  error?: string;
  /** Server-confirmed final path (may be auto-numbered). */
  resultPath?: string;
  /** Set on a `tooManyFiles` notice row: how many files were not queued. */
  skippedCount?: number;
}

export interface UseFileUploadOptions {
  client: FileUploadClient | undefined;
  maxBytes: number;
  /**
   * Identity of the target workspace AND the session composing into it.
   * When it changes (or the hook unmounts), in-flight uploads are aborted
   * and the queue is cleared, so an upload started for workspace A cannot
   * insert a path into workspace B, and an upload started in one session
   * cannot append its reference to another session's draft after a switch.
   */
  targetKey: string;
}

export interface UseFileUploadReturn {
  uploads: FileUploadItem[];
  /** True while any item is pending or in flight; gates composer submit. */
  isBusy: boolean;
  /**
   * Queue `files` for sequential upload into `targetDir` (relative to the
   * target workspace root; `'.'` for the root). `onUploaded` fires exactly
   * once per successful upload with the server-confirmed final path.
   * Returns how many files were actually queued (locally rejected files,
   * e.g. oversized ones, become error rows without queueing).
   */
  uploadFiles: (
    files: File[],
    targetDir: string,
    onUploaded?: (path: string) => void,
  ) => number;
  /** Remove a row and abort it if it is pending or in flight. */
  removeUpload: (id: string) => void;
}

interface QueuedUpload {
  id: string;
  file: File;
  targetPath: string;
  controller: AbortController;
  onUploaded?: (path: string) => void;
}

let uploadIdCounter = 0;
const SUCCESS_DISMISS_MS = 3000;
/**
 * Cap on files accepted per drop/picker batch. Unbounded batches render one
 * strip row per file and keep the strictly-sequential queue busy for hours;
 * overflow is surfaced as a single notice row instead.
 */
const MAX_FILES_PER_BATCH = 100;

function joinTargetPath(targetDir: string, filename: string): string {
  const dir = targetDir.replace(/\/+$/, '');
  if (dir === '' || dir === '.') return filename;
  return `${dir}/${filename}`;
}

export function useFileUpload(
  options: UseFileUploadOptions,
): UseFileUploadReturn {
  const { client, maxBytes, targetKey } = options;
  const [uploads, setUploads] = useState<FileUploadItem[]>([]);
  const uploadsRef = useRef<FileUploadItem[]>([]);
  const queueRef = useRef<QueuedUpload[]>([]);
  const activeUploadRef = useRef<QueuedUpload | undefined>(undefined);
  const processingRef = useRef(false);
  const generationRef = useRef(0);
  const prevTargetKeyRef = useRef(targetKey);
  // Invalidate the generation synchronously when the target changes:
  // `clientRef` is reassigned during render, so an in-flight completion
  // landing between commit and the reset effect below would otherwise pass
  // the old-generation guard while already holding the NEW target's client.
  if (prevTargetKeyRef.current !== targetKey) {
    prevTargetKeyRef.current = targetKey;
    generationRef.current += 1;
    activeUploadRef.current?.controller.abort();
    for (const queued of queueRef.current) queued.controller.abort();
  }
  const clientRef = useRef<FileUploadClient | undefined>(client);
  clientRef.current = client;
  const maxBytesRef = useRef(maxBytes);
  maxBytesRef.current = maxBytes;

  const commit = useCallback(() => {
    setUploads([...uploadsRef.current]);
  }, []);

  const patchItem = useCallback(
    (id: string, patch: Partial<FileUploadItem>) => {
      uploadsRef.current = uploadsRef.current.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      );
      commit();
    },
    [commit],
  );

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    const generation = generationRef.current;
    try {
      while (queueRef.current.length > 0) {
        if (generationRef.current !== generation) return;
        const next = queueRef.current.shift();
        if (!next) return;
        const { id, file, targetPath, controller, onUploaded } = next;
        if (controller.signal.aborted) continue;
        const activeClient = clientRef.current;
        if (!activeClient) {
          patchItem(id, { status: 'error', errorCode: 'noDaemon' });
          continue;
        }
        activeUploadRef.current = next;
        patchItem(id, { status: 'uploading', progress: 0 });
        try {
          const result = await activeClient.uploadWorkspaceFile({
            path: targetPath,
            data: file,
            signal: controller.signal,
            // The caller's AbortController owns cancellation; a valid
            // max-size upload can exceed the SDK's general default timeout.
            timeoutMs: 0,
            onProgress: (event) => {
              if (generationRef.current !== generation) return;
              const progress =
                event.total > 0 ? Math.min(1, event.loaded / event.total) : 0;
              const last =
                uploadsRef.current.find((item) => item.id === id)?.progress ??
                0;
              // Chunk arrivals fire tens of sub-percentage events per second;
              // commit only visible advances (>= 2%) and the final value so
              // the composer tree does not re-render for every chunk.
              if (progress < 1 && progress >= last && progress - last < 0.02) {
                return;
              }
              patchItem(id, { progress });
            },
          });
          if (generationRef.current !== generation) return;
          if (controller.signal.aborted) continue;
          patchItem(id, {
            status: 'done',
            progress: 1,
            resultPath: result.path,
          });
          setTimeout(() => {
            if (generationRef.current !== generation) return;
            uploadsRef.current = uploadsRef.current.filter(
              (item) => item.id !== id,
            );
            commit();
          }, SUCCESS_DISMISS_MS);
          try {
            onUploaded?.(result.path);
          } catch (err) {
            console.error('Failed to handle uploaded file', err);
          }
        } catch (err) {
          if (generationRef.current !== generation) return;
          if (controller.signal.aborted) {
            // Canceled/removed: drop the row. A late server publish is best
            // effort and cannot be recalled, but no reference is inserted.
            uploadsRef.current = uploadsRef.current.filter(
              (item) => item.id !== id,
            );
            commit();
            continue;
          }
          patchItem(id, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (activeUploadRef.current === next) {
            activeUploadRef.current = undefined;
          }
        }
      }
    } finally {
      processingRef.current = false;
      // Items may have been queued while this loop was winding down.
      if (queueRef.current.length > 0) void processQueue();
    }
  }, [commit, patchItem]);

  const uploadFiles = useCallback(
    (files: File[], targetDir: string, onUploaded?: (path: string) => void) => {
      if (files.length === 0) return 0;
      const limit = maxBytesRef.current;
      const accepted = files.slice(0, MAX_FILES_PER_BATCH);
      const skipped = files.length - accepted.length;
      let queuedCount = 0;
      for (const file of accepted) {
        uploadIdCounter += 1;
        const id = `upload-${uploadIdCounter}`;
        const targetPath = joinTargetPath(targetDir, file.name);
        if (file.size > limit) {
          uploadsRef.current = [
            ...uploadsRef.current,
            {
              id,
              file,
              targetPath,
              status: 'error',
              progress: 0,
              errorCode: 'tooLarge',
            },
          ];
          continue;
        }
        uploadsRef.current = [
          ...uploadsRef.current,
          { id, file, targetPath, status: 'pending', progress: 0 },
        ];
        queueRef.current.push({
          id,
          file,
          targetPath,
          controller: new AbortController(),
          onUploaded,
        });
        queuedCount += 1;
      }
      if (skipped > 0) {
        uploadIdCounter += 1;
        uploadsRef.current = [
          ...uploadsRef.current,
          {
            id: `upload-${uploadIdCounter}`,
            file: files[accepted.length] as File,
            targetPath: '',
            status: 'error',
            progress: 0,
            errorCode: 'tooManyFiles',
            skippedCount: skipped,
          },
        ];
      }
      commit();
      void processQueue();
      return queuedCount;
    },
    [commit, processQueue],
  );

  const removeUpload = useCallback(
    (id: string) => {
      if (activeUploadRef.current?.id === id) {
        activeUploadRef.current.controller.abort();
      }
      const queued = queueRef.current.find((q) => q.id === id);
      if (queued) {
        queued.controller.abort();
        queueRef.current = queueRef.current.filter((q) => q.id !== id);
      }
      uploadsRef.current = uploadsRef.current.filter((item) => item.id !== id);
      commit();
    },
    [commit],
  );

  // Reset the queue when the target workspace changes; abort anything in
  // flight so a stale upload cannot land in (or insert into) the new target.
  useEffect(() => {
    generationRef.current += 1;
    activeUploadRef.current?.controller.abort();
    for (const queued of queueRef.current) queued.controller.abort();
    queueRef.current = [];
    uploadsRef.current = [];
    commit();
    return () => {
      generationRef.current += 1;
      activeUploadRef.current?.controller.abort();
      for (const queued of queueRef.current) queued.controller.abort();
    };
  }, [targetKey, commit]);

  const isBusy = uploads.some(
    (item) => item.status === 'pending' || item.status === 'uploading',
  );

  return { uploads, isBusy, uploadFiles, removeUpload };
}
