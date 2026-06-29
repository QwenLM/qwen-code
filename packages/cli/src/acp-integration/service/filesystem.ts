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
import { createDebugLogger, isSubpath } from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

const RESOURCE_NOT_FOUND_CODE = -32002;
const PATH_OUTSIDE_WORKSPACE_KIND = 'path_outside_workspace';
const SYMLINK_ESCAPE_KIND = 'symlink_escape';
const LOCAL_READ_FALLBACK_ERROR_KINDS = new Set([
  PATH_OUTSIDE_WORKSPACE_KIND,
  SYMLINK_ESCAPE_KIND,
]);
const debugLogger = createDebugLogger('ACP_FILE_SYSTEM');

interface AcpFileSystemServiceOptions {
  localReadRoots?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): unknown {
  if (error instanceof RequestError) {
    return error.code;
  }

  if (isRecord(error)) {
    return error['code'];
  }

  return undefined;
}

function getErrorData(error: unknown): Record<string, unknown> | undefined {
  const data = isRecord(error) ? error['data'] : undefined;
  return isRecord(data) ? data : undefined;
}

function getErrorKind(error: unknown): string | undefined {
  const data = getErrorData(error);
  if (data && typeof data['errorKind'] === 'string') {
    return data['errorKind'];
  }
  return undefined;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;

  const normalized = new Error(getErrorMessage(error), {
    cause: error,
  }) as Error & Record<string, unknown>;
  if (isRecord(error)) {
    for (const [key, value] of Object.entries(error)) {
      if (
        key !== 'message' &&
        key !== 'cause' &&
        (key !== 'code' || typeof value === 'string')
      ) {
        normalized[key] = value;
      }
    }
  }
  return normalized;
}

function createEnoentError(filePath: string): NodeJS.ErrnoException {
  const err = new Error(`File not found: ${filePath}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.errno = -2;
  err.path = filePath;
  return err;
}

function isLocalReadFallbackErrorKind(errorKind: unknown): boolean {
  return (
    typeof errorKind === 'string' &&
    LOCAL_READ_FALLBACK_ERROR_KINDS.has(errorKind)
  );
}

async function resolveRealPath(value: string): Promise<string | undefined> {
  if (!value.trim()) return undefined;

  try {
    return await realpath(path.resolve(value));
  } catch {
    return undefined;
  }
}

async function isRealPathWithinRoot(
  filePath: string,
  root: string,
): Promise<boolean> {
  const [realFilePath, realRoot] = await Promise.all([
    resolveRealPath(filePath),
    resolveRealPath(root),
  ]);
  if (!realFilePath || !realRoot) return false;

  return isSubpath(realRoot, realFilePath);
}

export class AcpFileSystemService implements FileSystemService {
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly sessionId: string,
    private readonly capabilities: FileSystemCapability,
    private readonly fallback: FileSystemService,
    private readonly options: AcpFileSystemServiceOptions = {},
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

      const errorKind = getErrorKind(error);
      if (
        isLocalReadFallbackErrorKind(errorKind) &&
        (await this.isLocalReadFallbackPath(params.path))
      ) {
        debugLogger.debug('Falling back to local read after ACP error', {
          path: params.path,
          errorKind,
          error: getErrorMessage(error),
        });
        try {
          return await this.fallback.readTextFile(params);
        } catch (fallbackError) {
          debugLogger.warn('Local read fallback failed after ACP error', {
            path: params.path,
            errorKind,
            originalError: getErrorMessage(error),
            fallbackError: getErrorMessage(fallbackError),
          });
          throw new Error(
            `Local fallback read failed for ${params.path}: ${getErrorMessage(fallbackError)} (original ACP error: ${getErrorMessage(error)})`,
            { cause: fallbackError },
          );
        }
      }

      throw normalizeError(error);
    }

    return response;
  }

  async writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
  ): Promise<WriteTextFileResponse> {
    if (!this.capabilities.writeTextFile) {
      return this.fallback.writeTextFile(params);
    }

    const finalContent =
      params._meta?.['bom'] && params.content.charCodeAt(0) !== 0xfeff
        ? '\uFEFF' + params.content
        : params.content;

    try {
      await this.connection.writeTextFile({
        ...params,
        content: finalContent,
        sessionId: this.sessionId,
      });
    } catch (error) {
      throw normalizeError(error);
    }

    return { _meta: params._meta };
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }

  private async isLocalReadFallbackPath(filePath: string): Promise<boolean> {
    for (const root of this.options.localReadRoots ?? []) {
      if (await isRealPathWithinRoot(filePath, root)) return true;
    }
    return false;
  }
}
