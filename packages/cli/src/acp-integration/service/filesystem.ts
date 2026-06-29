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
import { getErrorMessage } from '../../utils/errors.js';
import path from 'node:path';

const RESOURCE_NOT_FOUND_CODE = -32002;
const PATH_OUTSIDE_WORKSPACE_KIND = 'path_outside_workspace';

interface AcpFileSystemServiceOptions {
  localReadRoots?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorCode(error: unknown): unknown {
  if (error instanceof RequestError) {
    return error.code;
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code;
  }

  return undefined;
}

function getErrorData(error: unknown): Record<string, unknown> | undefined {
  const data = isRecord(error) ? error['data'] : undefined;
  return isRecord(data) ? data : undefined;
}

function getErrorKind(error: unknown): unknown {
  const data = getErrorData(error);
  if (data && typeof data['errorKind'] === 'string') {
    return data['errorKind'];
  }
  if (isRecord(error) && typeof error['errorKind'] === 'string') {
    return error['errorKind'];
  }
  return undefined;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;

  const normalized = new Error(getErrorMessage(error)) as Error &
    Record<string, unknown>;
  if (isRecord(error)) {
    for (const [key, value] of Object.entries(error)) {
      if (key !== 'message') {
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

function isPathWithinRoot(filePath: string, root: string): boolean {
  if (!root.trim()) return false;

  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
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

      if (
        getErrorKind(error) === PATH_OUTSIDE_WORKSPACE_KIND &&
        this.isLocalReadFallbackPath(params.path)
      ) {
        return this.fallback.readTextFile(params);
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

    await this.connection.writeTextFile({
      ...params,
      content: finalContent,
      sessionId: this.sessionId,
    });

    return { _meta: params._meta };
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return this.fallback.findFiles(fileName, searchPaths);
  }

  private isLocalReadFallbackPath(filePath: string): boolean {
    return (this.options.localReadRoots ?? []).some((root) =>
      isPathWithinRoot(filePath, root),
    );
  }
}
