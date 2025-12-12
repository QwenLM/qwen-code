/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef } from 'react';
import type { VSCodeAPI } from '../../hooks/useVSCode.js';

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

  const [workspaceFiles, setWorkspaceFiles] = useState<
    Array<{
      id: string;
      label: string;
      description: string;
      path: string;
    }>
  >([]);

  // File reference mapping: @filename -> full path
  const fileReferenceMap = useRef<Map<string, string>>(new Map());

  // Whether workspace files have been requested
  const hasRequestedFilesRef = useRef(false);

  // Search debounce timer
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Request workspace files
   */
  const requestWorkspaceFiles = useCallback(
    (query?: string) => {
      if (!hasRequestedFilesRef.current && !query) {
        hasRequestedFilesRef.current = true;
      }

      // If there's a query, clear previous timer and set up debounce
      if (query && query.length >= 1) {
        if (searchTimerRef.current) {
          clearTimeout(searchTimerRef.current);
        }

        searchTimerRef.current = setTimeout(() => {
          vscode.postMessage({
            type: 'getWorkspaceFiles',
            data: { query },
          });
        }, 300);
      } else {
        vscode.postMessage({
          type: 'getWorkspaceFiles',
          data: query ? { query } : {},
        });
      }
    },
    [vscode],
  );

  /**
   * Add file reference
   */
  const addFileReference = useCallback((fileName: string, filePath: string) => {
    fileReferenceMap.current.set(fileName, filePath);
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
  }, []);

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

    // File reference operations
    addFileReference,
    getFileReference,
    clearFileReferences,

    // Operations
    requestWorkspaceFiles,
    requestActiveEditor,
    focusActiveEditor,
  };
};
