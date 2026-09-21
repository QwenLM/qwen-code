/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from '../config/config.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { FileReadCache } from '../services/fileReadCache.js';
import { WriteFileTool } from '../tools/write-file.js';
import { EditTool } from '../tools/edit.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { captureRuntimeFileVersion, writeRuntimeFile } from './runtime-file.js';
import { writeSandboxFile } from './file-worker-client.js';
import { getSandboxFileVersion } from './file-version.js';

vi.mock('./file-worker-client.js', () => ({ writeSandboxFile: vi.fn() }));
vi.mock('../telemetry/loggers.js', () => ({ logFileOperation: vi.fn() }));

describe('runtime file mutation routing', () => {
  let root: string;
  let service: StandardFileSystemService;
  let cache: FileReadCache;
  let config: Config;
  const trackEdit = vi.fn();
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(writeSandboxFile).mockReset();
    trackEdit.mockReset();
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-file-')),
    );
    service = new StandardFileSystemService();
    cache = new FileReadCache();
    config = {
      getShellExecutionSandbox: () => ({
        workspace: root,
        installation: '/installation',
        state: '/state',
        filesystem: 'workspace-write',
        network: 'closed',
      }),
      getTargetDir: () => root,
      getProjectRoot: () => root,
      getFileSystemService: () => service,
      getFileReadCache: () => cache,
      getFileReadCacheDisabled: () => false,
      getFileHistoryService: () => ({ trackEdit }),
      getDefaultFileEncoding: () => 'utf-8',
      getDebugMode: () => false,
      isRecordArtifactEnabled: () => false,
    } as unknown as Config;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('retains the ordinary delegated filesystem and provenance without policy', async () => {
    vi.spyOn(config, 'getShellExecutionSandbox').mockReturnValue(undefined);
    const write = vi.spyOn(service, 'writeTextFile').mockResolvedValue({});
    const params = {
      path: path.join(root, 'a'),
      content: 'text',
      toolWriteOrigin: 'edit' as const,
    };
    expect(captureRuntimeFileVersion(config, params.path)).toBeUndefined();
    await writeRuntimeFile(
      config,
      params,
      undefined,
      new AbortController().signal,
    );
    expect(write).toHaveBeenCalledWith(params);
    expect(writeSandboxFile).not.toHaveBeenCalled();
  });

  it('encodes BOM/CRLF bytes for the worker without a host write', async () => {
    const write = vi.spyOn(service, 'writeTextFile');
    await writeRuntimeFile(
      config,
      {
        path: path.join(root, 'a'),
        content: '世界\nline',
        _meta: { bom: true, lineEnding: 'crlf' },
      },
      null,
      new AbortController().signal,
    );
    expect(vi.mocked(writeSandboxFile).mock.calls[0][1].content).toEqual(
      Buffer.from('\ufeff世界\r\nline'),
    );
    expect(write).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'a'))).toBe(false);
  });

  it.each(['write', 'edit'] as const)(
    'does not create host directories or retry a failed %s',
    async (kind) => {
      const file = path.join(root, 'absent', 'nested', 'file');
      const write = vi.spyOn(service, 'writeTextFile');
      vi.mocked(writeSandboxFile).mockRejectedValue(
        new Error('backend unavailable'),
      );
      const tool =
        kind === 'write'
          ? new WriteFileTool(config).build({
              file_path: file,
              content: 'created',
            })
          : new EditTool(config).build({
              file_path: file,
              old_string: '',
              new_string: 'created',
            });
      const result = await tool.execute(new AbortController().signal);
      expect(result.error).toBeDefined();
      expect(writeSandboxFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writeSandboxFile).mock.calls[0][1].expected).toBeNull();
      expect(write).not.toHaveBeenCalled();
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    },
  );

  it.each(['write', 'edit'] as const)(
    'keeps the pre-read version across %s preparation',
    async (kind) => {
      const file = path.join(root, 'file');
      fs.writeFileSync(file, 'original');
      const expected = getSandboxFileVersion(file);
      vi.spyOn(config, 'getFileReadCacheDisabled').mockReturnValue(true);
      const read = service.readTextFile.bind(service);
      vi.spyOn(service, 'readTextFile').mockImplementation(async (params) => {
        const text = await read(params);
        fs.writeFileSync(file, 'external content');
        return text;
      });
      vi.mocked(writeSandboxFile).mockRejectedValue(
        Object.assign(new Error('stale'), { code: 'ESTALE' }),
      );
      const tool =
        kind === 'write'
          ? new WriteFileTool(config).build({ file_path: file, content: 'new' })
          : new EditTool(config).build({
              file_path: file,
              old_string: 'original',
              new_string: 'new',
            });
      const result = await tool.execute(new AbortController().signal);
      expect(result.error?.type).toBe(ToolErrorType.FILE_CHANGED_SINCE_READ);
      expect(vi.mocked(writeSandboxFile).mock.calls[0][1].expected).toEqual(
        expected,
      );
      expect(fs.readFileSync(file, 'utf8')).toBe('external content');
    },
  );
});
