/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileSystemService } from '@qwen-code/qwen-code-core';
import type * as acp from '../acp.js';
import { ACP_ERROR_CODES } from '../errorCodes.js';

/**
 * ACP client-based implementation of FileSystemService
 */
export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly client: acp.Client,
    private readonly sessionId: string,
    private readonly capabilities: acp.FileSystemCapability,
    private readonly fallback: FileSystemService,
  ) {}

  async readTextFile(filePath: string): Promise<string> {
    if (!this.capabilities.readTextFile) {
      return this.fallback.readTextFile(filePath);
    }

    let response: { content: string };
    try {
      response = await this.client.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
        line: null,
        limit: null,
      });
    } catch (error) {
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;

      if (errorCode === ACP_ERROR_CODES.RESOURCE_NOT_FOUND) {
        const err = new Error(
          `File not found: ${filePath}`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        err.errno = -2;
        err.path = filePath;
        throw err;
      }

      throw error;
    }

    return response.content;
  }

  async writeTextFile(
    filePath: string,
    content: string,
    options?: { bom?: boolean },
  ): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(filePath, content, options);
    }

    // Prepend BOM character if requested
    const finalContent = options?.bom ? '\uFEFF' + content : content;

    await this.client.writeTextFile({
      path: filePath,
      content: finalContent,
      sessionId: this.sessionId,
    });
  }

  async detectFileBOM(filePath: string): Promise<boolean> {
    // Try to detect BOM through ACP client first by reading first line
    if (this.capabilities.readTextFile) {
      try {
        const response = await this.client.readTextFile({
          path: filePath,
          sessionId: this.sessionId,
          line: null,
          limit: 1,
        });
        // Check if content starts with BOM character (U+FEFF)
        // Use codePointAt for better Unicode support and check content length first
        return (
          response.content.length > 0 &&
          response.content.codePointAt(0) === 0xfeff
        );
      } catch {
        // Fall through to fallback if ACP read fails
      }
    }
    // Fall back to local filesystem detection
    return this.fallback.detectFileBOM(filePath);
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }
}
