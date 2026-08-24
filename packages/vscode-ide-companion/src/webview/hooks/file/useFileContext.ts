/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { VSCodeAPI } from '../../hooks/useVSCode.js';

export interface WorkspaceFile {
  id: string;
  label: string;
  description: string;
  path: string;
}

/**
 * File context management Hook
 * Manages active file, selection content, and workspace file list
 */
export const useFileContext = (vscode: VSCodeAPI) => {
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeSelection, setActiveSelection] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);

  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);

  // File reference mapping: @filename -> full path
  const fileReferenceMap = useRef<Map<string, string>>(new Map());

  // Whether workspace files have been requested
  const hasRequestedFilesRef = useRef(false);

  // Use request ids to avoid applying stale workspace file responses.
  const workspaceFilesRequestIdRef = useRef(0);
  const latestWorkspaceFilesRequestIdRef = useRef<number | null>(null);
  const workspaceFileResolversRef = useRef(
    new Map<
      number,
      { resolve: (files: WorkspaceFile[]) => void; cleanup: () => void }
    >(),
  );

  // Last non-empty query to decide when to refetch full list
  const lastQueryRef = useRef<string | undefined>(undefined);

  // Search debounce timer
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const searchTimerRequestIdRef = useRef<number | null>(null);

  const finishRequest = useCallback(
    (requestId: number, files: WorkspaceFile[]) => {
      const pending = workspaceFileResolversRef.current.get(requestId);
      if (!pending) return;
      workspaceFileResolversRef.current.delete(requestId);
      pending.cleanup();
      pending.resolve(files);
    },
    [],
  );

  /**
   * Request workspace files
   */
  const requestWorkspaceFiles = useCallback(
    (query?: string, signal?: AbortSignal): Promise<WorkspaceFile[]> => {
      if (signal?.aborted) return Promise.resolve([]);
      const normalizedQuery = query?.trim();
      const normalizedQueryKey = normalizedQuery?.toLowerCase();

      const request = (requestId: number): Promise<WorkspaceFile[]> => {
        latestWorkspaceFilesRequestIdRef.current = requestId;
        return new Promise((resolve) => {
          const abort = () => finishRequest(requestId, []);
          signal?.addEventListener('abort', abort, { once: true });
          workspaceFileResolversRef.current.set(requestId, {
            resolve,
            cleanup: () => signal?.removeEventListener('abort', abort),
          });
          if (signal?.aborted) abort();
        });
      };

      // If there's a query, clear previous timer and set up debounce
      if (normalizedQuery && normalizedQuery.length >= 1) {
        if (normalizedQueryKey === lastQueryRef.current) {
          return Promise.resolve(workspaceFiles);
        }
        if (searchTimerRef.current) {
          clearTimeout(searchTimerRef.current);
          if (searchTimerRequestIdRef.current !== null) {
            finishRequest(searchTimerRequestIdRef.current, []);
          }
        }

        const requestId = workspaceFilesRequestIdRef.current + 1;
        workspaceFilesRequestIdRef.current = requestId;
        const result = request(requestId);
        searchTimerRef.current = setTimeout(() => {
          vscode.postMessage({
            type: 'getWorkspaceFiles',
            data: { query: normalizedQuery, requestId },
          });
          searchTimerRef.current = null;
          searchTimerRequestIdRef.current = null;
        }, 300);
        searchTimerRequestIdRef.current = requestId;
        lastQueryRef.current = normalizedQueryKey;
        return result;
      } else {
        if (searchTimerRef.current) {
          clearTimeout(searchTimerRef.current);
          searchTimerRef.current = null;
          if (searchTimerRequestIdRef.current !== null) {
            finishRequest(searchTimerRequestIdRef.current, []);
            searchTimerRequestIdRef.current = null;
          }
        }

        // For empty query, request once initially and whenever we are returning from a search
        const shouldRequestFullList =
          !hasRequestedFilesRef.current || lastQueryRef.current !== undefined;

        if (shouldRequestFullList) {
          const requestId = workspaceFilesRequestIdRef.current + 1;
          workspaceFilesRequestIdRef.current = requestId;
          const result = request(requestId);
          lastQueryRef.current = undefined;
          hasRequestedFilesRef.current = true;
          vscode.postMessage({
            type: 'getWorkspaceFiles',
            data: { requestId },
          });
          return result;
        }

        return Promise.resolve(workspaceFiles);
      }
    },
    [finishRequest, vscode, workspaceFiles],
  );

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      for (const requestId of workspaceFileResolversRef.current.keys()) {
        finishRequest(requestId, []);
      }
    },
    [finishRequest],
  );

  /**
   * Apply workspace file responses only if they are current.
   */
  const setWorkspaceFilesFromResponse = useCallback(
    (files: WorkspaceFile[], requestId?: number) => {
      if (typeof requestId === 'number') {
        finishRequest(requestId, files);
      }
      if (
        typeof requestId === 'number' &&
        latestWorkspaceFilesRequestIdRef.current !== requestId
      ) {
        return;
      }
      setWorkspaceFiles(files);

      // Keep the host-side path mapping in sync with provider results. The
      // embedded Web Shell inserts the selected path into the composer, while
      // the ACP bridge still consumes the existing @name -> path map.
      for (const file of files) {
        fileReferenceMap.current.set(file.label, file.path);
        fileReferenceMap.current.set(file.description, file.path);
        fileReferenceMap.current.set(file.path, file.path);
      }
    },
    [finishRequest],
  );

  /** Resolve @file references from composer text for the ACP bridge. */
  const getFileReferences = useCallback((text: string) => {
    const references: Array<{ name: string; value: string }> = [];
    let currentIndex = 0;
    while (currentIndex < text.length) {
      const atIndex = text.indexOf('@', currentIndex);
      if (atIndex < 0) break;
      let matched = false;
      for (let end = text.length; end > atIndex + 1; end -= 1) {
        const name = text.slice(atIndex + 1, end).trimEnd();
        const value = fileReferenceMap.current.get(name);
        if (!value) continue;
        const nextChar = end < text.length ? text[end] : '';
        if (nextChar && nextChar !== '@' && !/\s/.test(nextChar)) continue;
        references.push({ name, value });
        currentIndex = end;
        matched = true;
        break;
      }
      if (!matched) currentIndex = atIndex + 1;
    }
    return references;
  }, []);

  /**
   * Add file reference (called when user selects a file from completion)
   * Also resets the last query so that backspacing and re-typing will trigger a fresh search
   */
  const addFileReference = useCallback((fileName: string, filePath: string) => {
    fileReferenceMap.current.set(fileName, filePath);
    lastQueryRef.current = undefined;
  }, []);

  /**
   * Get file reference
   */
  const getFileReference = useCallback(
    (fileName: string) => fileReferenceMap.current.get(fileName),
    [],
  );

  /**
   * Clear file references
   */
  const clearFileReferences = useCallback(() => {
    fileReferenceMap.current.clear();
    for (const file of workspaceFiles) {
      fileReferenceMap.current.set(file.label, file.path);
      fileReferenceMap.current.set(file.description, file.path);
      fileReferenceMap.current.set(file.path, file.path);
    }
  }, [workspaceFiles]);

  /**
   * Request active editor info
   */
  const requestActiveEditor = useCallback(() => {
    vscode.postMessage({ type: 'getActiveEditor', data: {} });
  }, [vscode]);

  /**
   * Focus on active editor
   */
  const focusActiveEditor = useCallback(() => {
    vscode.postMessage({
      type: 'focusActiveEditor',
      data: {},
    });
  }, [vscode]);

  return {
    // State
    activeFileName,
    activeFilePath,
    activeSelection,
    workspaceFiles,
    hasRequestedFiles: hasRequestedFilesRef.current,

    // State setters
    setActiveFileName,
    setActiveFilePath,
    setActiveSelection,
    setWorkspaceFiles,
    setWorkspaceFilesFromResponse,
    getFileReferences,

    // File reference operations
    addFileReference,
    getFileReference,
    clearFileReferences,

    // Operations
    requestWorkspaceFiles,
    searchWorkspaceFiles: requestWorkspaceFiles,
    requestActiveEditor,
    focusActiveEditor,
  };
};
