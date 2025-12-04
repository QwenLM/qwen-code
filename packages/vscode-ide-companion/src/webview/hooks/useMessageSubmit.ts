/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import type { VSCodeAPI } from './useVSCode.js';
import { getRandomLoadingMessage } from '../../constants/loadingMessages.js';

interface UseMessageSubmitProps {
  vscode: VSCodeAPI;
  inputText: string;
  setInputText: (text: string) => void;
  inputFieldRef: React.RefObject<HTMLDivElement>;
  isStreaming: boolean;

  fileContext: {
    getFileReference: (fileName: string) => string | undefined;
    activeFilePath: string | null;
    activeFileName: string | null;
    activeSelection: { startLine: number; endLine: number } | null;
    clearFileReferences: () => void;
  };

  messageHandling: {
    setWaitingForResponse: (message: string) => void;
  };
}

/**
 * Message submit Hook
 * Handles message submission logic and context parsing
 */
export const useMessageSubmit = ({
  vscode,
  inputText,
  setInputText,
  inputFieldRef,
  isStreaming,
  fileContext,
  messageHandling,
}: UseMessageSubmitProps) => {
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      if (!inputText.trim() || isStreaming) {
        return;
      }

      // Handle /login command - show inline loading while extension authenticates
      if (inputText.trim() === '/login') {
        setInputText('');
        if (inputFieldRef.current) {
          inputFieldRef.current.textContent = '';
        }
        vscode.postMessage({
          type: 'login',
          data: {},
        });
        // Show a friendly loading message in the chat while logging in
        try {
          messageHandling.setWaitingForResponse('Logging in to Qwen Code...');
        } catch (_err) {
          // Best-effort UI hint; ignore if hook not available
        }
        return;
      }

      messageHandling.setWaitingForResponse(getRandomLoadingMessage());

      // Parse @file references from input text
      const context: Array<{
        type: string;
        name: string;
        value: string;
        startLine?: number;
        endLine?: number;
      }> = [];
      const fileRefPattern = /@([^\s]+)/g;
      let match;

      while ((match = fileRefPattern.exec(inputText)) !== null) {
        const fileName = match[1];
        const filePath = fileContext.getFileReference(fileName);

        if (filePath) {
          context.push({
            type: 'file',
            name: fileName,
            value: filePath,
          });
        }
      }

      // Add active file selection context if present
      if (fileContext.activeFilePath) {
        const fileName = fileContext.activeFileName || 'current file';
        context.push({
          type: 'file',
          name: fileName,
          value: fileContext.activeFilePath,
          startLine: fileContext.activeSelection?.startLine,
          endLine: fileContext.activeSelection?.endLine,
        });
      }

      let fileContextForMessage:
        | {
            fileName: string;
            filePath: string;
            startLine?: number;
            endLine?: number;
          }
        | undefined;

      if (fileContext.activeFilePath && fileContext.activeFileName) {
        fileContextForMessage = {
          fileName: fileContext.activeFileName,
          filePath: fileContext.activeFilePath,
          startLine: fileContext.activeSelection?.startLine,
          endLine: fileContext.activeSelection?.endLine,
        };
      }

      vscode.postMessage({
        type: 'sendMessage',
        data: {
          text: inputText,
          context: context.length > 0 ? context : undefined,
          fileContext: fileContextForMessage,
        },
      });

      setInputText('');
      if (inputFieldRef.current) {
        inputFieldRef.current.textContent = '';
      }
      fileContext.clearFileReferences();
    },
    [
      inputText,
      isStreaming,
      setInputText,
      inputFieldRef,
      vscode,
      fileContext,
      messageHandling,
    ],
  );

  return { handleSubmit };
};
