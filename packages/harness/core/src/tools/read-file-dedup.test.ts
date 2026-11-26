/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import type { Message } from '../protocol/transcript/message.js';
import { restoreToolFileReadState } from '../attachments/transcript-state.js';
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import {
  createToolFileStateCache,
  markFileStateResultPartial,
} from '../utils/fileStateCache.js';
import * as rangeReader from '../utils/readFileInRange.js';
import { discoverJitContext } from './jit-context.js';
import { ReadFileTool, type ReadFileToolParams } from './read-file.js';
import { EditTool } from './edit.js';
import { WriteFileTool } from './write-file.js';
import type { ToolUseContext } from './tool-types.js';

vi.mock('../config-service/index.js', () => ({ getConfigValue: vi.fn() }));
vi.mock('./jit-context.js', () => ({
  activateConditionalSkillsForPath: vi.fn(),
  discoverJitContext: vi.fn().mockResolvedValue(undefined),
}));

describe('ReadFileTool deduplication', () => {
  let dir: string;
  let file: string;
  let config: Config;
  let tool: ReadFileTool;
  let ctx: ToolUseContext;
  const body = 'alpha\nbeta\ngamma\ndelta';

  beforeEach(async () => {
    dir = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'read-dedup-'),
    );
    file = path.join(dir, 'fixture.txt');
    await fs.writeFile(file, body);
    const cache = createToolFileStateCache();
    config = {
      fileReadState: cache,
      getTargetDir: () => dir,
      getModel: () => 'test-model',
      getActiveModel: () => 'test-model',
      getWorkspaceContext: () => createMockWorkspaceContext(dir),
      getFileSystemService: () => new StandardFileSystemService(),
      getHookSystem: () => undefined,
      isPlanMode: () => false,
      isInteractive: () => false,
      isAutoMemoryEnabled: () => false,
      isAutoMemoryUserScopeEnabled: () => false,
      validateSettingsContent: () => null,
      validatePathAccess: () => null,
      storage: {
        getProjectTempDir: () => path.join(dir, '.temp'),
        getPlansDir: () => path.join(dir, '.plans'),
        getProjectMemoryTempDir: () => path.join(dir, '.memory'),
      },
    } as unknown as Config;
    tool = new ReadFileTool(config);
    ctx = { signal: new AbortController().signal, fileReadState: cache };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const read = (params: Partial<ReadFileToolParams> = {}, context = ctx) =>
    tool.build({ file_path: file, ...params }).executeWithContext!(context);

  it('skips content I/O for an unchanged range and runs context discovery', async () => {
    const diskRead = vi.spyOn(rangeReader, 'readFileInRange');
    const first = await read();
    expect(first.toolUseResult).toMatchObject({ type: 'text' });
    const state = ctx.fileReadState!.get(file);
    diskRead.mockClear();
    vi.mocked(discoverJitContext).mockClear();
    const second = await read({ file_path: dir + '/./fixture.txt', offset: 1 });
    expect(second.error).toBeUndefined();
    expect(second.toolUseResult).toEqual({
      type: 'file_unchanged',
      file: { filePath: file },
    });
    expect(second.llmContent).toBe(
      'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
    );
    expect(second.llmContent).not.toContain(body);
    expect(diskRead).not.toHaveBeenCalled();
    expect(discoverJitContext).toHaveBeenCalled();
    expect(ctx.fileReadState!.get(file)).toBe(state);
  });

  it('deduplicates only the most recently read offset and limit', async () => {
    await read();
    expect((await read({ offset: 2, limit: 2 })).toolUseResult).toMatchObject({
      type: 'text',
      file: { content: 'beta\ngamma' },
    });
    expect((await read({ offset: 2, limit: 2 })).toolUseResult).toMatchObject({
      type: 'file_unchanged',
    });
    expect((await read({ offset: 1, limit: 4 })).toolUseResult).toMatchObject({
      type: 'text',
    });
    expect((await read({ offset: 2, limit: 2 })).toolUseResult).toMatchObject({
      type: 'text',
    });
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('deduplicates completed default reads with an explicit 2000-line limit', async () => {
    await read();
    expect(ctx.fileReadState!.get(file)?.limit).toBeUndefined();
    expect((await read({ limit: 2000 })).toolUseResult).toMatchObject({ type: 'file_unchanged' });
    expect((await read()).toolUseResult).toMatchObject({ type: 'file_unchanged' });
  });

  it('preserves implicit pages as partial and deduplicates explicit ranges', async () => {
    await fs.writeFile(file, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n'));
    expect((await read()).toolUseResult).toMatchObject({
      type: 'text', file: { numLines: 2000, totalLines: 3000 },
    });
    expect(ctx.fileReadState!.get(file)).toMatchObject({ limit: 2000, isPartialView: true });
    expect((await read({ limit: 2000 })).toolUseResult).toMatchObject({
      type: 'text', file: { numLines: 2000 },
    });
    expect((await read({ limit: 2000 })).toolUseResult).toMatchObject({ type: 'file_unchanged' });
    expect((await read({ limit: 2500 })).toolUseResult).toMatchObject({
      type: 'text', file: { numLines: 2500 },
    });
    expect((await read({ offset: 2001 })).toolUseResult).toMatchObject({
      type: 'text', file: { startLine: 2001, numLines: 1000 },
    });
    expect((await read({ offset: 2001 })).toolUseResult).toMatchObject({ type: 'file_unchanged' });
    expect((await read({ offset: 2001, limit: 2000 })).toolUseResult).toMatchObject({ type: 'file_unchanged' });
    expect((await read({ offset: 2001, limit: 2000 })).toolUseResult).toMatchObject({ type: 'file_unchanged' });
  });

  it('deduplicates changed content when its mtime is preserved', async () => {
    const time = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(file, time, time);
    await read();
    await fs.writeFile(file, body.replace('alpha', 'ALPHA'));
    await fs.utimes(file, time, time);
    expect((await fs.stat(file)).mtimeMs).toBe(time.getTime());
    expect((await read()).toolUseResult).toMatchObject({
      type: 'file_unchanged',
    });
  });

  it('rereads when mtime changes', async () => {
    await read();
    const stat = await fs.stat(file);
    await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 2000));
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('rereads a replacement file with a different mtime', async () => {
    const time = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(file, time, time);
    await read();
    const replacement = path.join(dir, 'replacement.txt');
    await fs.writeFile(replacement, 'new');
    await fs.utimes(replacement, time, new Date(time.getTime() + 2000));
    await fs.rename(replacement, file);
    expect((await read()).toolUseResult).toMatchObject({
      type: 'text',
      file: { content: 'new' },
    });
  });

  it('reports a missing file after a successful Read', async () => {
    await read();
    await fs.unlink(file);
    expect((await read()).error).toBeDefined();
  });

  it('deduplicates an atomically replaced file when its mtime is preserved', async () => {
    const time = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(file, time, time);
    await read();
    const replacement = path.join(dir, 'replacement.txt');
    await fs.writeFile(replacement, 'replacement with different length');
    await fs.utimes(replacement, time, time);
    await fs.rename(replacement, file);
    expect((await read()).toolUseResult).toMatchObject({
      type: 'file_unchanged',
    });
  });

  it.each(['Edit', 'Write'] as const)(
    'returns content on the first Read after %s',
    async (name) => {
      await read();
      const write =
        name === 'Edit'
          ? new EditTool(config).build({
              file_path: file,
              old_string: 'alpha',
              new_string: 'ALPHA',
            })
          : new WriteFileTool(config).build({
              file_path: file,
              content: 'ALPHA',
            });
      expect((await write.executeWithContext!(ctx)).error).toBeUndefined();
      expect(ctx.fileReadState!.get(file)?.readMtimeMs).toBeUndefined();
      expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
      expect((await read()).toolUseResult).toMatchObject({
        type: 'file_unchanged',
      });
    },
  );

  it('rereads a result marked as partial', async () => {
    const result = await read();
    markFileStateResultPartial(result);
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('rereads when the previous content is absent from model context', async () => {
    await read();
    const state = ctx.fileReadState!.get(file)!;
    ctx.fileReadState!.set(file, { ...state, contentNotInModelContext: true });
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('rereads after the read state is cleared', async () => {
    await read();
    restoreToolFileReadState(ctx.fileReadState!, [], dir);
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('rereads restored history even when the message timestamp matches mtime', async () => {
    const result = await read();
    restoreToolFileReadState(
      ctx.fileReadState!,
      [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'read',
                name: 'Read',
                input: { file_path: file },
              },
            ],
          },
        },
        {
          type: 'user',
          timestamp: (await fs.stat(file)).mtime.toISOString(),
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'read',
                content: result.llmContent,
              },
            ],
          },
          toolUseResult: result.toolUseResult,
        },
      ] as unknown as Message[],
      dir,
    );
    expect(ctx.fileReadState!.get(file)?.content).toBe(body);
    expect(ctx.fileReadState!.get(file)?.readMtimeMs).toBeUndefined();
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it.each([
    { invocationOrigin: 'internal' as const },
    { dedupUnchangedReads: false },
    { resultConsumption: 'programmatic' as const },
  ])('returns content when deduplication is disabled: %j', async (override) => {
    await read();
    const internal = { ...ctx, ...override };
    for (let i = 0; i < 2; i++)
      expect((await read({}, internal)).toolUseResult).toMatchObject({
        type: 'text',
        file: { content: body },
      });
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
  });

  it('returns content for execute calls without a tool context', async () => {
    await read();
    expect(
      (await tool.build({ file_path: file }).execute(ctx.signal)).toolUseResult,
    ).toMatchObject({ type: 'text' });
  });

  it('keeps deduplication state separate for each agent', async () => {
    await read();
    const child = {
      ...ctx,
      agentId: 'child',
      fileReadState: createToolFileStateCache(),
    };
    expect((await read({}, child)).toolUseResult).toMatchObject({
      type: 'text',
    });
    expect((await read({}, child)).toolUseResult).toMatchObject({
      type: 'file_unchanged',
    });
  });

  it('records the mtime returned by the read when the file changes during I/O', async () => {
    const time = new Date('2026-01-01T00:00:00Z');
    await fs.utimes(file, time, time);
    const original = rangeReader.readFileInRange;
    vi.spyOn(rangeReader, 'readFileInRange').mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        await fs.writeFile(file, 'changed during read');
        return result;
      },
    );
    await read();
    expect(ctx.fileReadState!.get(file)?.readMtimeMs).toBe(time.getTime());
    expect((await read()).toolUseResult).toMatchObject({
      type: 'text',
      file: { content: 'changed during read' },
    });
  });

  it('deduplicates large content evicted from the cache body', async () => {
    await fs.writeFile(file, Array.from({ length: 2000 }, () => 'line').join('\n'));
    expect((await read()).toolUseResult).toMatchObject({ type: 'text' });
    expect(ctx.fileReadState!.get(file)?.content).toBe('');
    expect((await read()).toolUseResult).toMatchObject({
      type: 'file_unchanged',
    });
  });

  it('falls back to reading content when the mtime check fails', async () => {
    await read();
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(new Error('stat unavailable'));
    expect((await read()).toolUseResult).toMatchObject({
      type: 'text',
      file: { content: body },
    });
  });

  it('preserves the read state when context discovery is cancelled', async () => {
    await read();
    const state = ctx.fileReadState!.get(file);
    const controller = new AbortController();
    const reason = new Error('cancelled');
    vi.mocked(discoverJitContext).mockImplementationOnce(async () => {
      controller.abort(reason);
    });
    await expect(read({}, { ...ctx, signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(ctx.fileReadState!.get(file)).toBe(state);
  });
});
