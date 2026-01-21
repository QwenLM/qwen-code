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

  async writeTextFile(filePath: string, content: string): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(filePath, content);
    }

    await this.client.writeTextFile({
      path: filePath,
      content,
      sessionId: this.sessionId,
    });
  }
  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }
}
