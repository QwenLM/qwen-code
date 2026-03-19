/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentSideConnection,
  FileSystemCapability,
  ReadTextFileRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type {
  FileSystemService,
  ReadTextFileResponse,
} from '@qwen-code/qwen-code-core';

const RESOURCE_NOT_FOUND_CODE = -32002;

function getErrorCode(error: unknown): unknown {
  if (error instanceof RequestError) {
    return error.code;
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code;
  }

  return undefined;
}

function createEnoentError(filePath: string): NodeJS.ErrnoException {
  const err = new Error(`File not found: ${filePath}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.errno = -2;
  err.path = filePath;
  return err;
}

export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapability,
    private readonly fallback: FileSystemService,
  ) {}

  async readTextFile(
    params: Omit<ReadTextFileRequest, 'sessionId'>,
  ): Promise<ReadTextFileResponse> {
    if (!this.capabilities.readTextFile) {
      return this.fallback.readTextFile(params);
    }

    let response: ReadTextFileResponse;
    try {
      response = await this.connection.readTextFile({
        ...params,
        sessionId: this.sessionId,
      });
    } catch (error) {
      const errorCode = getErrorCode(error);

      if (errorCode === RESOURCE_NOT_FOUND_CODE) {
        throw createEnoentError(params.path);
      }

      throw error;
    }

    return response;
  }

  async writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
  ): Promise<WriteTextFileResponse> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(params);
    }

    const finalContent = params._meta?.['bom']
      ? '\uFEFF' + params.content
      : params.content;

    try {
      await this.connection.writeTextFile({
        ...params,
        content: finalContent,
        sessionId: this.sessionId,
      });
    } catch {
      // Fall back to local filesystem if ACP write fails (e.g. file does not
      // yet exist and the IDE companion rejects the path).
      return this.fallback.writeTextFile(params);
    }

    return { _meta: params._meta };
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }
}
