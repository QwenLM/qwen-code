/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentSideConnection,
  FileSystemCapability,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type {
  FileReadResult,
  FileSystemService,
} from '@qwen-code/qwen-code-core';

const RESOURCE_NOT_FOUND_CODE = -32002;

function isInvalidPathWriteError(error: unknown): boolean {
  const data =
    typeof error === 'object' && error !== null && 'data' in error
      ? (error as { data?: unknown }).data
      : undefined;

  if (typeof data === 'string') {
    return data.toLowerCase() === 'invalid path';
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? (error as { message?: unknown }).message
        : undefined;

  return (
    typeof message === 'string' &&
    message.toLowerCase().includes('invalid path')
  );
}

export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapability,
    private readonly fallback: FileSystemService,
  ) {}

  async readTextFile(filePath: string): Promise<string> {
    if (!this.capabilities.readTextFile) {
      return this.fallback.readTextFile(filePath);
    }

    let response: { content: string };
    try {
      response = await this.connection.readTextFile({
        path: filePath,
        sessionId: this.sessionId,
      });
    } catch (error) {
      const errorCode =
        error instanceof RequestError
          ? error.code
          : typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined;

      if (errorCode === RESOURCE_NOT_FOUND_CODE) {
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

  async readTextFileWithInfo(filePath: string): Promise<FileReadResult> {
    // ACP protocol does not expose encoding metadata; delegate to the local
    // fallback which performs a single-pass read with encoding detection.
    return this.fallback.readTextFileWithInfo(filePath);
  }

  async writeTextFile(
    filePath: string,
    content: string,
    options?: { bom?: boolean; encoding?: string },
  ): Promise<void> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(filePath, content, options);
    }

    const finalContent = options?.bom ? '\uFEFF' + content : content;
    try {
      await this.connection.writeTextFile({
        path: filePath,
        content: finalContent,
        sessionId: this.sessionId,
      });
    } catch (error) {
      if (isInvalidPathWriteError(error)) {
        await this.fallback.writeTextFile(filePath, content, options);
        return;
      }
      throw error;
    }
  }

  async detectFileBOM(filePath: string): Promise<boolean> {
    if (this.capabilities.readTextFile) {
      try {
        const response = await this.connection.readTextFile({
          path: filePath,
          sessionId: this.sessionId,
          limit: 1,
        });
        return (
          response.content.length > 0 &&
          response.content.codePointAt(0) === 0xfeff
        );
      } catch {
        // Fall through to fallback if ACP read fails
      }
    }
    return this.fallback.detectFileBOM(filePath);
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }
}
