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

      // Handle line offset and limit
      if (params.line !== null || params.limit !== null) {
        const lines = content.split('\n');
        const startLine = params.line || 0;
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ACP] Failed to read file ${params.path}:`, errorMsg);

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

    try {
      // Ensure directory exists
      const dirName = path.dirname(params.path);
      console.log(`[ACP] Ensuring directory exists: ${dirName}`);
      await fs.mkdir(dirName, { recursive: true });

      // Write file
      await fs.writeFile(params.path, params.content, 'utf-8');

      console.log(`[ACP] Successfully wrote file: ${params.path}`);
      return null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ACP] Failed to write file ${params.path}:`, errorMsg);

      throw new Error(`Failed to write file '${params.path}': ${errorMsg}`);
    }
  }
}
