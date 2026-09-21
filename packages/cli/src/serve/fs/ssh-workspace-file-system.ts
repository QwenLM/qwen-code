/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  SshWorkspaceClient,
  SshWorkspaceError,
  type SshWorkspace,
} from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import { FsError } from './errors.js';
import { createAuditPublisher } from './audit.js';
import {
  MAX_READ_BYTES,
  MAX_TEXT_SCAN_BYTES,
  enforceWriteSize,
  assertTrustedForIntent,
} from './policy.js';
import type { Intent, ResolvedPath } from './paths.js';
import type {
  ContentHash,
  FsEntry,
  FsStat,
  ReadMeta,
  WorkspaceFileSystem,
  WorkspaceFileSystemFactory,
  WriteTextAtomicOutcome,
  WriteTextAtomicOptions,
  WriteMode,
} from './workspace-file-system.js';

interface RemoteRead {
  content: string;
  hash: ContentHash;
  sizeBytes: number;
}

export function createSshWorkspaceFileSystemFactory(options: {
  cwd: string;
  connection: SshWorkspace;
  trusted: boolean;
  generationGuard?: { assertOpen(): void };
  emit: (event: BridgeEvent) => void;
}): WorkspaceFileSystemFactory {
  const audit = createAuditPublisher({
    emit: options.emit,
    boundWorkspace: options.cwd,
  });
  const assertOpen = () => options.generationGuard?.assertOpen();
  const assertCanWrite = () => {
    assertOpen();
    assertTrustedForIntent(options.trusted, 'write');
  };
  const remotePath = (input: string): string => {
    if (input.includes('\0'))
      throw new FsError('path_outside_workspace', 'Invalid path.');
    const localRelative = path.relative(options.cwd, input);
    if (
      path.isAbsolute(input) &&
      localRelative !== '..' &&
      !localRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(localRelative)
    ) {
      return path.posix.join(
        options.connection.directory,
        ...localRelative.split(path.sep),
      );
    }
    const resolved = path.posix.resolve(options.connection.directory, input);
    const relative = path.posix.relative(
      options.connection.directory,
      resolved,
    );
    if (
      relative === '..' ||
      relative.startsWith('../') ||
      path.posix.isAbsolute(relative)
    ) {
      throw new FsError(
        'path_outside_workspace',
        'Path is outside the SSH workspace.',
      );
    }
    return resolved;
  };
  const localPath = (input: string): ResolvedPath =>
    path.join(
      options.cwd,
      ...path.posix
        .relative(options.connection.directory, remotePath(input))
        .split('/'),
    ) as ResolvedPath;
  return {
    sshWorkspace: options.connection,
    assertCanWrite,
    forRequest(ctx) {
      const request = async <T>(
        operation: string,
        params: Record<string, unknown>,
      ): Promise<T> => {
        const client = new SshWorkspaceClient(options.connection);
        const started = Date.now();
        const input =
          typeof params['path'] === 'string'
            ? params['path']
            : options.connection.directory;
        const intent: Intent =
          operation === 'write' || operation === 'mkdir'
            ? 'write'
            : operation === 'list'
              ? 'list'
              : operation === 'glob'
                ? 'glob'
                : operation === 'stat'
                  ? 'stat'
                  : 'read';
        try {
          assertOpen();
          assertTrustedForIntent(options.trusted, intent);
          const result = await client.request<T>(
            operation,
            params,
            AbortSignal.timeout(30_000),
          );
          assertOpen();
          audit.recordAccess(ctx, {
            intent,
            operation,
            absolute: localPath(input),
            durationMs: Date.now() - started,
          });
          return result;
        } catch (error) {
          let failure = error;
          if (error instanceof SshWorkspaceError) {
            switch (error.code) {
              case 'path_outside_workspace':
              case 'symlink_escape':
              case 'path_not_found':
              case 'binary_file':
              case 'file_too_large':
              case 'hash_mismatch':
              case 'file_already_exists':
              case 'permission_denied':
                failure = new FsError(error.code, error.message);
                break;
              case 'too_large':
                failure = new FsError('file_too_large', error.message);
                break;
              case 'invalid_argument':
              case 'unsupported_pattern':
                failure = new FsError('parse_error', error.message);
                break;
              case 'unsupported_encoding':
              case 'unsupported_file':
              case 'not_file':
              case 'not_directory':
              case 'unsupported_ignore':
              case 'unsupported_operation':
                failure = new FsError('parse_error', error.message, {
                  status: 422,
                });
                break;
              default:
                failure = new FsError('io_error', error.message);
            }
          }
          if (failure instanceof FsError)
            audit.recordDenied(ctx, {
              intent,
              input,
              errorKind: failure.kind,
              message: failure.message,
            });
          throw failure;
        } finally {
          client.dispose();
        }
      };
      const metadata = (read: RemoteRead): ReadMeta => ({
        encoding: 'utf-8',
        bom: read.content.startsWith('\ufeff'),
        lineEnding: read.content.includes('\r\n') ? 'crlf' : 'lf',
        sizeBytes: read.sizeBytes,
        hash: read.hash,
      });
      const encodeForWrite = async (
        p: ResolvedPath,
        content: string,
        opts: Partial<WriteTextAtomicOptions>,
        mode: WriteMode,
      ): Promise<string> => {
        enforceWriteSize(Buffer.byteLength(content));
        if (opts.encoding && !/^utf-?8$/i.test(opts.encoding))
          throw new FsError(
            'parse_error',
            'SSH workspaces currently support UTF-8 text writes.',
          );
        let existing: ReadMeta | undefined;
        if (
          mode !== 'create' &&
          (opts.bom === undefined || opts.lineEnding === undefined)
        ) {
          try {
            existing = metadata(
              await request<RemoteRead>('read', { path: remotePath(p) }),
            );
          } catch (error) {
            if (
              mode !== 'overwrite' ||
              !(error instanceof FsError) ||
              ![
                'path_not_found',
                'permission_denied',
                'file_too_large',
                'binary_file',
              ].includes(error.kind)
            )
              throw error;
          }
        }
        const lineEnding = opts.lineEnding ?? existing?.lineEnding;
        let encoded = lineEnding
          ? content.replace(/\r?\n/g, lineEnding === 'crlf' ? '\r\n' : '\n')
          : content;
        const bom = opts.bom ?? existing?.bom;
        if (bom === true && !encoded.startsWith('\ufeff'))
          encoded = '\ufeff' + encoded;
        if (bom === false) encoded = encoded.replace(/^\ufeff/, '');
        enforceWriteSize(Buffer.byteLength(encoded));
        return encoded;
      };
      const fileSystem: WorkspaceFileSystem = {
        async resolve(input, intent) {
          try {
            assertOpen();
            assertTrustedForIntent(options.trusted, intent);
            return localPath(input);
          } catch (error) {
            audit.recordDenied(ctx, {
              intent,
              input,
              errorKind:
                error instanceof FsError ? error.kind : 'internal_error',
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        stat: (p) => request<FsStat>('stat', { path: remotePath(p) }),
        async readText(p, opts = {}) {
          if (opts.cursor)
            throw new FsError(
              'parse_error',
              'SSH text cursors are not supported; use line and limit.',
            );
          const read = await request<RemoteRead>('read', {
            path: remotePath(p),
          });
          if (
            read.sizeBytes > MAX_TEXT_SCAN_BYTES ||
            (read.sizeBytes > MAX_READ_BYTES &&
              opts.line === undefined &&
              opts.limit === undefined &&
              opts.maxBytes === undefined)
          ) {
            throw new FsError(
              'file_too_large',
              'Use line and limit to read a large remote file.',
            );
          }
          for (const value of [opts.line, opts.limit, opts.maxBytes]) {
            if (
              value !== undefined &&
              (!Number.isSafeInteger(value) || value < 1)
            )
              throw new FsError(
                'parse_error',
                'Read bounds must be positive integers.',
              );
          }
          if (opts.maxBytes !== undefined && opts.maxBytes > MAX_READ_BYTES)
            throw new FsError(
              'file_too_large',
              'Requested read exceeds the byte limit.',
            );
          const text = read.content.replace(/^\ufeff/, '');
          const lines = text.split('\n');
          const lineCount =
            lines.length - (text.endsWith('\n') || text === '' ? 1 : 0);
          const start = (opts.line ?? 1) - 1;
          let content = lines
            .slice(
              start,
              opts.limit === undefined ? undefined : start + opts.limit,
            )
            .join('\n');
          const maxBytes = opts.maxBytes ?? MAX_READ_BYTES;
          const bytes = Buffer.from(content);
          if (bytes.length > maxBytes) {
            let end = maxBytes;
            while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
            content = bytes.subarray(0, end).toString('utf8');
          }
          const hasMore =
            bytes.length > maxBytes ||
            (opts.limit !== undefined && start + opts.limit < lineCount);
          return {
            content,
            meta: {
              ...metadata(read),
              truncated: content !== text,
              hasMore,
              originalLineCount: lineCount,
            },
          };
        },
        async readBytes(p, opts) {
          const read = await fileSystem.readBytesWindow(p, opts);
          if (!opts && read.truncated)
            throw new FsError(
              'file_too_large',
              'Use a byte window to read a large remote file.',
            );
          return read.buffer;
        },
        async readBytesWindow(p, opts = {}) {
          if (
            opts.maxBytes !== undefined &&
            (!Number.isSafeInteger(opts.maxBytes) ||
              opts.maxBytes < 1 ||
              opts.maxBytes > MAX_READ_BYTES)
          )
            throw new FsError('parse_error', 'Invalid byte window size.');
          if (
            opts.offset !== undefined &&
            (!Number.isSafeInteger(opts.offset) || opts.offset < 0)
          )
            throw new FsError('parse_error', 'Invalid byte window offset.');
          const read = await request<{
            data: string;
            sizeBytes: number;
            hash: ContentHash;
          }>('readBytes', {
            path: remotePath(p),
            offset: opts.offset ?? 0,
            maxBytes: opts.maxBytes ?? MAX_READ_BYTES,
          });
          const buffer = Buffer.from(read.data, 'base64');
          const offset = opts.offset ?? 0;
          const truncated = offset > 0 || buffer.length < read.sizeBytes;
          return {
            buffer,
            sizeBytes: read.sizeBytes,
            returnedBytes: buffer.length,
            offset,
            truncated,
            ...(truncated ? {} : { hash: read.hash }),
          };
        },
        list: (p, opts = {}) =>
          request<FsEntry[]>('list', { path: remotePath(p), ...opts }),
        async glob(pattern, opts = {}) {
          const result = await request<{
            paths: string[];
            truncated?: boolean;
          }>('glob', {
            pattern,
            path: opts.cwd
              ? remotePath(opts.cwd)
              : options.connection.directory,
            maxResults: opts.maxResults,
            includeIgnored: opts.includeIgnored,
          });
          return Object.assign(
            result.paths.map(localPath),
            result.truncated ? { truncated: true } : {},
          );
        },
        async writeTextAtomic(p, content, opts) {
          const encoded = await encodeForWrite(p, content, opts, opts.mode);
          const result = await request<Omit<WriteTextAtomicOutcome, 'meta'>>(
            'write',
            {
              path: remotePath(p),
              content: encoded,
              mode: opts.mode,
              expectedHash: opts.expectedHash,
            },
          );
          return { ...result, meta: metadata({ ...result, content: encoded }) };
        },
        async writeTextOverwrite(p, content, opts = {}) {
          const encoded = await encodeForWrite(p, content, opts, 'overwrite');
          const result = await request<Omit<WriteTextAtomicOutcome, 'meta'>>(
            'write',
            { path: remotePath(p), content: encoded, mode: 'overwrite' },
          );
          return { ...result, meta: metadata({ ...result, content: encoded }) };
        },
        async writeText(p, content, opts) {
          await fileSystem.writeTextOverwrite(p, content, opts);
        },
        async edit(p, oldText, newText, opts = {}) {
          const read = await request<RemoteRead>('read', {
            path: remotePath(p),
          });
          if (opts.expectedHash && opts.expectedHash !== read.hash)
            throw new FsError(
              'hash_mismatch',
              'Remote file changed. Read it again before editing.',
            );
          if (!oldText || !read.content.includes(oldText))
            throw new FsError(
              'text_not_found',
              'Text was not found in the remote file.',
            );
          if (
            opts.expectedHash !== undefined &&
            read.content.split(oldText).length !== 2
          )
            throw new FsError(
              'ambiguous_text_match',
              'Text matches more than once.',
            );
          const result = await fileSystem.writeTextAtomic(
            p,
            read.content.replace(oldText, () => newText),
            {
              mode: 'replace',
              expectedHash: read.hash,
              bom: metadata(read).bom,
              lineEnding: metadata(read).lineEnding,
            },
          );
          return {
            writtenBytes: result.sizeBytes,
            hash: result.hash,
            meta: result.meta,
          };
        },
        editAtomic: (p, oldText, newText, opts) =>
          fileSystem.edit(p, oldText, newText, opts),
        async writeBytesAtomic(p, data) {
          assertCanWrite();
          enforceWriteSize(data.length, 16 * 1024 * 1024);
          return request('write', {
            path: remotePath(p),
            data: data.toString('base64'),
            mode: 'create',
          });
        },
        async mkdir(p, opts) {
          await request('mkdir', {
            path: remotePath(p),
            recursive: opts?.recursive ?? false,
          });
        },
      };
      return fileSystem;
    },
  };
}
