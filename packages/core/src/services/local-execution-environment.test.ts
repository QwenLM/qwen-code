/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { LocalExecutionEnvironment } from './local-execution-environment.js';

describe('LocalExecutionEnvironment', () => {
  let workspace: string;
  let environment: LocalExecutionEnvironment;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'execution-environment-'));
    environment = new LocalExecutionEnvironment(
      new Config({
        targetDir: workspace,
        cwd: workspace,
        debugMode: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
        shouldUseNodePtyShell: false,
      }),
    );
  });

  afterEach(async () => {
    await environment.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  async function execute(
    id: string,
    toolName: string,
    params: Record<string, unknown>,
  ) {
    await environment.prepare({ id, toolName, params }, signal);
    return environment.execute(id, signal);
  }

  it('preserves prior-read enforcement across invocations and detects external writes', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'before\n');
    const unread = await execute('unread', ToolNames.EDIT, {
      file_path: file,
      old_string: 'before',
      new_string: 'after',
    });
    expect(unread.error?.type).toBe('edit_requires_prior_read');
    const read = await execute('read', ToolNames.READ_FILE, {
      file_path: file,
    });
    expect(read.error).toBeUndefined();
    const edited = await execute('edit', ToolNames.EDIT, {
      file_path: file,
      old_string: 'before',
      new_string: 'after',
    });
    expect(edited.error).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('after\n');
    await writeFile(file, 'externally changed\n');
    const stale = await execute('stale', ToolNames.EDIT, {
      file_path: file,
      old_string: 'externally changed',
      new_string: 'lost',
    });
    expect(stale.error?.type).toBe('file_changed_since_read');
    expect(await readFile(file, 'utf8')).toBe('externally changed\n');
  });

  it('invalidates quoted reads after history eviction without revoking prior-read rights', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'before\n');
    await execute('first', ToolNames.READ_FILE, { file_path: file });
    const cached = await execute('cached', ToolNames.READ_FILE, {
      file_path: file,
    });
    expect(cached.llmContent).toContain('unchanged since last read');
    await environment.invalidateReadCache([file]);
    const reread = await execute('reread', ToolNames.READ_FILE, {
      file_path: file,
    });
    expect(reread.llmContent).toContain('before');
    await environment.invalidateReadCache([file]);
    const edited = await execute('edit', ToolNames.EDIT, {
      file_path: file,
      old_string: 'before',
      new_string: 'after',
    });
    expect(edited.error).toBeUndefined();
    await environment.invalidateReadCache();
    const cleared = await execute('cleared', ToolNames.EDIT, {
      file_path: file,
      old_string: 'after',
      new_string: 'bad',
    });
    expect(cleared.error?.type).toBe('edit_requires_prior_read');
  });

  it('cleans completed and released invocations and refuses unsupported tools', async () => {
    const file = path.join(workspace, 'new.txt');
    await execute('write', ToolNames.WRITE_FILE, {
      file_path: file,
      content: 'ok',
    });
    await expect(environment.execute('write', signal)).rejects.toThrow(
      'Unknown execution invocation',
    );
    await environment.prepare(
      {
        id: 'released',
        toolName: ToolNames.READ_FILE,
        params: { file_path: file },
      },
      signal,
    );
    await environment.release('released', signal);
    await expect(environment.permission('released', signal)).rejects.toThrow(
      'Unknown execution invocation',
    );
    await expect(
      environment.prepare(
        { id: 'monitor', toolName: ToolNames.MONITOR, params: {} },
        signal,
      ),
    ).rejects.toThrow('Unsupported execution tool');
  });

  it('uses the same workspace for file creation, glob, grep and directory listing', async () => {
    const file = path.join(workspace, 'searchable.txt');
    expect(
      (
        await execute('create', ToolNames.WRITE_FILE, {
          file_path: file,
          content: 'unique-worker-content\n',
        })
      ).error,
    ).toBeUndefined();
    const glob = await execute('glob', ToolNames.GLOB, {
      pattern: '*.txt',
      path: workspace,
    });
    expect(glob.error).toBeUndefined();
    expect(glob.llmContent).toContain('searchable.txt');
    const grep = await execute('grep', ToolNames.GREP, {
      pattern: 'unique-worker-content',
      path: workspace,
    });
    expect(grep.error).toBeUndefined();
    expect(grep.llmContent).toContain('searchable.txt');
    const ls = await execute('ls', ToolNames.LS, { path: workspace });
    expect(ls.error).toBeUndefined();
    expect(ls.llmContent).toContain('searchable.txt');
  });

  it('executes and cancels shell commands without a model or auth initialization', async () => {
    const result = await execute('shell', ToolNames.SHELL, {
      command: 'printf worker-ok',
      is_background: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('worker-ok');
    await environment.prepare(
      {
        id: 'cancel',
        toolName: ToolNames.SHELL,
        params: { command: 'printf started; sleep 30', is_background: false },
      },
      signal,
    );
    const controller = new AbortController();
    const running = environment.execute('cancel', controller.signal);
    await environment.release('cancel', signal);
    await expect(environment.execute('cancel', signal)).rejects.toThrow(
      'Invocation is executing',
    );
    setTimeout(() => controller.abort(), 100);
    const cancelled = await running;
    expect(JSON.stringify(cancelled)).toMatch(/cancel|abort/i);
    await expect(environment.execute('cancel', signal)).rejects.toThrow(
      'Unknown execution invocation',
    );
  }, 10_000);
});
