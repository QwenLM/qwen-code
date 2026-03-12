/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP File Operation Handler
 *
 * Responsible for handling file read and write operations in the ACP protocol
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { getErrorMessage } from '../utils/errorMessage.js';

/**
 * ACP File Operation Handler Class
 * Provides file read and write functionality according to ACP protocol specifications
 */
export class AcpFileHandler {
  /**
   * Handle read text file request
   *
   * @param params - File read parameters
   * @param params.path - File path
   * @param params.sessionId - Session ID
   * @param params.line - Starting line number (optional)
   * @param params.limit - Read line limit (optional)
   * @returns File content
   * @throws Error when file reading fails
   */
  async handleReadTextFile(params: {
    path: string;
    sessionId: string;
    line: number | null;
    limit: number | null;
  }): Promise<{ content: string }> {
    console.log(`[ACP] fs/read_text_file request received for: ${params.path}`);
    console.log(`[ACP] Parameters:`, {
      line: params.line,
      limit: params.limit,
      sessionId: params.sessionId,
    });

    try {
      const content = await fs.readFile(params.path, 'utf-8');
      console.log(
        `[ACP] Successfully read file: ${params.path} (${content.length} bytes)`,
      );

      // Handle line offset and limit.
      // ACP spec: `line` is 1-based (first line = 1).
      if (params.line !== null || params.limit !== null) {
        const lines = content.split('\n');
        const startLine = Math.max(0, (params.line ?? 1) - 1);
        const endLine = params.limit ? startLine + params.limit : lines.length;
        const selectedLines = lines.slice(startLine, endLine);
        const result = { content: selectedLines.join('\n') };
        console.log(`[ACP] Returning ${selectedLines.length} lines`);
        return result;
      }

      const result = { content };
      console.log(`[ACP] Returning full file content`);
      return result;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(`[ACP] Failed to read file ${params.path}:`, errorMsg);

      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') {
        throw error;
      }

      throw new Error(`Failed to read file '${params.path}': ${errorMsg}`);
    }
  }

  /**
   * Handle write text file request
   *
   * @param params - File write parameters
   * @param params.path - File path
   * @param params.content - File content
   * @param params.sessionId - Session ID
   * @returns null indicates success
   * @throws Error when file writing fails
   */
  async handleWriteTextFile(params: {
    path: string;
    content: string;
    sessionId: string;
  }): Promise<null> {
    console.log(
      `[ACP] fs/write_text_file request received for: ${params.path}`,
    );
    console.log(`[ACP] Content size: ${params.content.length} bytes`);

    // Validate path parameter
    if (!params.path || typeof params.path !== 'string') {
      const error = new Error(
        `Invalid path: path must be a non-empty string, received ${String(params.path)}`,
      );
      console.error(`[ACP] Invalid path parameter:`, params.path);
      throw error;
    }

    // Trim and validate the path
    const trimmedPath = params.path.trim();
    if (!trimmedPath) {
      const error = new Error(
        'Invalid path: path cannot be empty or whitespace-only',
      );
      console.error(`[ACP] Empty path provided`);
      throw error;
    }

    // Check for null bytes which can cause security issues
    if (trimmedPath.includes('\0')) {
      const error = new Error(
        'Invalid path: path contains null byte character',
      );
      console.error(`[ACP] Path contains null byte:`, trimmedPath);
      throw error;
    }

    try {
      // Ensure directory exists
      const dirName = path.dirname(trimmedPath);
      console.log(`[ACP] Ensuring directory exists: ${dirName}`);
      await fs.mkdir(dirName, { recursive: true });

      // Write file
      await fs.writeFile(trimmedPath, params.content, 'utf-8');

      console.log(`[ACP] Successfully wrote file: ${trimmedPath}`);
      return null;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      console.error(`[ACP] Failed to write file ${trimmedPath}:`, errorMsg);

      // Provide more specific error messages based on error code
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'EINVAL') {
        throw new Error(
          `Invalid path '${trimmedPath}': ${errorMsg}. Ensure the path format is valid for your operating system.`,
          { cause: error },
        );
      } else if (nodeError?.code === 'EACCES') {
        throw new Error(
          `Permission denied writing to '${trimmedPath}': ${errorMsg}`,
          { cause: error },
        );
      } else if (nodeError?.code === 'ENOSPC') {
        throw new Error(
          `No space left on device while writing to '${trimmedPath}': ${errorMsg}`,
          { cause: error },
        );
      } else if (nodeError?.code === 'EISDIR') {
        throw new Error(
          `Cannot write to directory '${trimmedPath}': ${errorMsg}. Expected a file path.`,
          { cause: error },
        );
      }

      throw new Error(`Failed to write file '${trimmedPath}': ${errorMsg}`, {
        cause: error,
      });
    }
  }
}
