/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { SshExecutionEnvironment } from './ssh-execution-environment.js';

const transport = vi.hoisted(() => ({
  request: vi.fn(),
  execute: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./ssh-workspace.js', () => ({
  SshWorkspaceClient: class {
    request = transport.request;
    execute = transport.execute;
    dispose = transport.dispose;
  },
  SshWorkspaceError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { SshWorkspaceError } from './ssh-workspace.js';

describe('SshExecutionEnvironment', () => {
  let environment: SshExecutionEnvironment;
  let files: Map<string, string>;
  const signal = new AbortController().signal;
  const remote = '/srv/project';
  const anchor = '/local/ssh/anchor';
  const remoteFile = `${remote}/file.txt`;
  let nextId = 0;
  const hash = (content: string) =>
    `sha256:${createHash('sha256').update(content).digest('hex')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    files = new Map([[remoteFile, 'first\r\nsecond\r\n']]);
    transport.request.mockImplementation(async (operation, params) => {
      const content = files.get(params.path);
      if (operation === 'read') {
        if (content === undefined)
          throw new SshWorkspaceError('path_not_found', 'path_not_found');
        return JSON.parse(
          JSON.stringify({
            content,
            hash: hash(content),
            sizeBytes: Buffer.byteLength(content),
          }),
        );
      }
      if (operation === 'write') {
        if (params.mode === 'create' && content !== undefined)
          throw new SshWorkspaceError(
            'file_already_exists',
            'file_already_exists',
          );
        if (params.mode === 'replace' && content === undefined)
          throw new SshWorkspaceError('path_not_found', 'path_not_found');
        if (params.expectedHash && params.expectedHash !== hash(content!))
          throw new SshWorkspaceError('hash_mismatch', 'hash_mismatch');
        files.set(params.path, params.content);
        return {
          created: content === undefined,
          sizeBytes: Buffer.byteLength(params.content),
          hash: hash(params.content),
        };
      }
      if (operation === 'glob')
        return { paths: [remoteFile], truncated: false };
      if (operation === 'grep')
        return { text: 'file.txt:1:first', truncated: true };
      if (operation === 'list')
        return [
          { name: 'file.txt', kind: 'file', ignored: false },
          { name: 'src', kind: 'directory', ignored: false },
        ];
      throw new Error(`Unexpected operation: ${operation}`);
    });
    transport.execute.mockResolvedValue({
      stdout: 'remote output',
      stderr: '',
      exitCode: 0,
    });
    environment = new SshExecutionEnvironment(
      { host: 'dev-host', directory: remote },
      anchor,
    );
  });

  afterEach(async () => environment.dispose());

  /** Prepares a call; `modification` (a manually edited proposal) is sent only when given. */
  async function prepare(
    toolName: string,
    params: Record<string, unknown>,
    id = String(nextId++),
    modification?: { oldContent: string; newContent: string },
  ) {
    const prepared = await environment.prepare(
      { id, toolName, params, ...(modification && { modification }) },
      signal,
    );
    return { id, prepared };
  }

  async function execute(toolName: string, params: Record<string, unknown>) {
    const { id } = await prepare(toolName, params);
    return environment.execute(id, signal);
  }

  async function read(filePath = remoteFile) {
    return execute(ToolNames.READ_FILE, { file_path: filePath });
  }

  const approve = (id: string, payload?: { newContent: string }) =>
    environment.confirm(
      id,
      ToolConfirmationOutcome.ProceedOnce,
      payload,
      signal,
    );

  /** Preparing this call must fail because the file was not read first. */
  const expectNeedsRead = (toolName: string, params: Record<string, unknown>) =>
    expect(prepare(toolName, params)).rejects.toThrow('Read the remote file');

  const expectShellTimeout = (timeoutMs: number) =>
    expect(transport.execute).toHaveBeenLastCalledWith(
      'pwd',
      expect.objectContaining({ timeoutMs }),
    );

  /** Replaces the environment with one built from these settings. */
  async function reconfigure(settings: {
    outputThreshold?: number;
    shellDefaultTimeoutMs?: number;
  }) {
    await environment.dispose();
    environment = new SshExecutionEnvironment(
      { host: 'host', directory: remote },
      anchor,
      settings,
    );
  }

  it.each(['file.txt', remoteFile, `${anchor}/file.txt`])(
    'reads the same remote file for path %s without touching the anchor',
    async (filePath) => {
      const output = await read(filePath);
      expect(output.llmContent).toBe('first\r\nsecond\r\n');
      expect(transport.request).toHaveBeenCalledWith(
        'read',
        { path: remoteFile },
        expect.any(AbortSignal),
      );
      expect(output.persistedOutputFiles).toEqual([]);
    },
  );

  it.each([
    '../outside',
    '/etc/passwd',
    `${anchor}/../other/file.txt`,
    '/srv/project-other/file.txt',
  ])('rejects paths outside the workspace: %s', async (filePath) => {
    await expect(read(filePath)).rejects.toThrow('outside the SSH workspace');
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('keeps filesystem failures remote and never falls back', async () => {
    transport.request.mockRejectedValueOnce(
      new SshWorkspaceError('symlink_escape', 'symlink_escape'),
    );
    await expect(read()).rejects.toThrow('symlink_escape');
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('requires a prior read and detects changes before preparation', async () => {
    const params = {
      file_path: remoteFile,
      old_string: 'first',
      new_string: 'edited',
    };
    await expectNeedsRead(ToolNames.EDIT, params);
    await read();
    files.set(remoteFile, 'first changed');
    await expect(prepare(ToolNames.EDIT, params)).rejects.toThrow(
      'changed since the last read',
    );
    expect(files.get(remoteFile)).toBe('first changed');
  });

  it('returns the real preview before approval and uses CAS when executing', async () => {
    await read();
    const { id } = await prepare(ToolNames.EDIT, {
      file_path: remoteFile,
      old_string: 'first',
      new_string: '$& edited',
    });
    expect(await environment.permission(id, signal)).toBe('ask');
    expect(await environment.confirmation(id, signal)).toMatchObject({
      type: 'edit',
      originalContent: 'first\r\nsecond\r\n',
      newContent: '$& edited\r\nsecond\r\n',
      skipIdeDiff: true,
    });
    expect(files.get(remoteFile)).toBe('first\r\nsecond\r\n');
    await approve(id);
    await environment.execute(id, signal);
    expect(files.get(remoteFile)).toBe('$& edited\r\nsecond\r\n');
    expect(transport.request).toHaveBeenLastCalledWith(
      'write',
      {
        path: remoteFile,
        content: '$& edited\r\nsecond\r\n',
        mode: 'replace',
        createParents: false,
        expectedHash: hash('first\r\nsecond\r\n'),
      },
      expect.any(AbortSignal),
    );
  });

  it('refuses stale writes after approval and does not retry them', async () => {
    await read();
    const { id } = await prepare(ToolNames.WRITE_FILE, {
      file_path: remoteFile,
      content: 'proposal',
    });
    await approve(id);
    files.set(remoteFile, 'external write');
    await expect(environment.execute(id, signal)).rejects.toThrow(
      'hash_mismatch',
    );
    expect(files.get(remoteFile)).toBe('external write');
    expect(
      transport.request.mock.calls.filter(
        ([operation]) => operation === 'write',
      ),
    ).toHaveLength(1);
  });

  it('uses exclusive creation for new files, including races after preview', async () => {
    const { id } = await prepare(ToolNames.WRITE_FILE, {
      file_path: `${remote}/new.txt`,
      content: 'mine',
    });
    expect(await environment.confirmation(id, signal)).toMatchObject({
      originalContent: null,
      newContent: 'mine',
    });
    files.set(`${remote}/new.txt`, 'someone else');
    await expect(environment.execute(id, signal)).rejects.toThrow(
      'file_already_exists',
    );
    expect(files.get(`${remote}/new.txt`)).toBe('someone else');
  });

  it('creates new files remotely and preserves UTF-8 BOM and line endings', async () => {
    const content = '\uFEFFhello\r\nworld\r\n';
    await execute(ToolNames.WRITE_FILE, {
      file_path: `${anchor}/new.txt`,
      content,
    });
    expect(files.get(`${remote}/new.txt`)).toBe(content);
    expect(files.has(`${anchor}/new.txt`)).toBe(false);
    expect((await read(`${remote}/new.txt`)).llmContent).toBe(content);
  });

  it.each(['\n', '\r\n'])(
    'matches multiline edits with %j arguments and preserves BOM/CRLF',
    async (ending) => {
      const file = `${remote}/crlf.txt`;
      files.set(file, '\uFEFFalpha\r\nbeta\r\ngamma\r\n');
      await read(file);
      await execute(ToolNames.EDIT, {
        file_path: file,
        old_string: ['alpha', 'beta'].join(ending),
        new_string: ['alpha', 'changed'].join(ending),
      });
      expect(files.get(file)).toBe('\uFEFFalpha\r\nchanged\r\ngamma\r\n');
      await execute(ToolNames.WRITE_FILE, {
        file_path: file,
        content: 'red\ngreen\n',
      });
      expect(files.get(file)).toBe('\uFEFFred\r\ngreen\r\n');
    },
  );

  it('accepts a whole-file edit copied from a BOM read without duplicating the BOM', async () => {
    const file = `${remote}/bom.txt`;
    const content = '\uFEFFalpha\r\nbeta\r\n';
    files.set(file, content);
    await read(file);
    await execute(ToolNames.EDIT, {
      file_path: file,
      old_string: content,
      new_string: '\uFEFFchanged\n',
    });
    expect(files.get(file)).toBe('\uFEFFchanged\r\n');
  });

  it('preserves an existing LF file when replacement arguments contain CRLF', async () => {
    const file = `${remote}/lf.txt`;
    files.set(file, 'alpha\nbeta\n');
    await read(file);
    await execute(ToolNames.EDIT, {
      file_path: file,
      old_string: 'alpha\r\nbeta',
      new_string: 'changed\r\nlines',
    });
    expect(files.get(file)).toBe('changed\nlines\n');
  });

  it('keeps BOM and CRLF for manually edited proposals and confirmation payloads', async () => {
    files.set(remoteFile, '\uFEFFfirst\r\nsecond\r\n');
    await read(remoteFile);
    const { id } = await prepare(
      ToolNames.EDIT,
      { file_path: remoteFile, old_string: 'first', new_string: 'proposal' },
      'formatted-modification',
      {
        oldContent: '\uFEFFfirst\r\nsecond\r\n',
        newContent: 'manual\nproposal\n',
      },
    );
    expect(await environment.confirmation(id, signal)).toMatchObject({
      newContent: '\uFEFFmanual\r\nproposal\r\n',
    });
    await approve(id, { newContent: '\uFEFFfinal\ncontent\n' });
    await environment.execute(id, signal);
    expect(files.get(remoteFile)).toBe('\uFEFFfinal\r\ncontent\r\n');
  });

  it('honors manually edited proposals and confirmation payloads', async () => {
    await read();
    const { id } = await prepare(
      ToolNames.EDIT,
      { file_path: remoteFile, old_string: 'first', new_string: 'proposal' },
      'modified',
      { oldContent: 'first\r\nsecond\r\n', newContent: 'manually edited' },
    );
    expect(await environment.confirmation(id, signal)).toMatchObject({
      originalContent: 'first\r\nsecond\r\n',
      newContent: 'manually edited',
    });
    await approve(id, { newContent: 'final reviewed content' });
    await environment.execute(id, signal);
    expect(files.get(remoteFile)).toBe('final reviewed content');
  });

  it('does not allow modified_by_user to bypass prior reading', async () => {
    await expectNeedsRead(ToolNames.WRITE_FILE, {
      file_path: remoteFile,
      content: 'overwrite',
      modified_by_user: true,
    });
  });

  it('requires unique edit matches unless replace_all is requested', async () => {
    files.set(remoteFile, 'same same');
    await read();
    const params = {
      file_path: remoteFile,
      old_string: 'same',
      new_string: 'new',
    };
    await expect(prepare(ToolNames.EDIT, params)).rejects.toThrow(
      'multiple locations',
    );
    await execute(ToolNames.EDIT, { ...params, replace_all: true });
    expect(files.get(remoteFile)).toBe('new new');
  });

  it('allows editing large files after a paginated read while preserving unseen content', async () => {
    const prefix = 'first line\r\n'.repeat(3000);
    const original = `${prefix}target line\r\nlast line\r\n`;
    files.set(remoteFile, original);
    expect(
      (
        await execute(ToolNames.READ_FILE, {
          file_path: remoteFile,
          offset: 3000,
          limit: 1,
        })
      ).llmContent,
    ).toBe('target line\r');
    await execute(ToolNames.EDIT, {
      file_path: remoteFile,
      old_string: 'target line',
      new_string: 'updated line',
    });
    expect(files.get(remoteFile)).toBe(
      `${prefix}updated line\r\nlast line\r\n`,
    );
    expect(transport.request).toHaveBeenLastCalledWith(
      'write',
      expect.objectContaining({ expectedHash: hash(original) }),
      expect.any(AbortSignal),
    );
  });

  it('bounds large read output and retains prior-read protection for overwrites', async () => {
    files.set(remoteFile, 'x'.repeat(40_000));
    const output = await read();
    expect(String(output.llmContent).length).toBeLessThan(25_000);
    expect(output.llmContent).toContain('truncated');
    expect(output.outputBudgetApplied).toBe(true);
    expect(output.resultFilePaths).toEqual([]);
    await execute(ToolNames.WRITE_FILE, {
      file_path: remoteFile,
      content: 'overwrite',
    });
    expect(files.get(remoteFile)).toBe('overwrite');
  });

  it('routes shell cwd and streaming output to SSH and clears prior-read rights', async () => {
    await read();
    transport.execute.mockImplementationOnce(async (_command, options) => {
      options.onOutput?.('progress');
      options.onOutput?.(' complete');
      return { stdout: 'done', stderr: 'warning', exitCode: 2 };
    });
    const { id } = await prepare(ToolNames.SHELL, {
      command: 'pwd',
      directory: `${anchor}/src`,
      is_background: false,
      timeout: 2000,
    });
    expect(await environment.permission(id, signal)).toBe('ask');
    expect(await environment.confirmation(id, signal)).toMatchObject({
      type: 'exec',
      command: 'pwd',
    });
    const onOutput = vi.fn();
    const output = await environment.execute(id, signal, onOutput);
    expect(transport.execute).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ directory: `${remote}/src`, timeoutMs: 2000 }),
    );
    expect(onOutput.mock.calls).toEqual([['progress'], ['progress complete']]);
    expect(output.error).toBeUndefined();
    expect(output.llmContent).toContain('Exit code: 2');
    expect(output.llmContent).toContain('done');
    expect(output.llmContent).toContain('warning');
    await expectNeedsRead(ToolNames.WRITE_FILE, {
      file_path: remoteFile,
      content: 'overwrite',
    });
  });

  it('uses the normal two-minute foreground shell timeout by default', async () => {
    await execute(ToolNames.SHELL, { command: 'pwd' });
    expectShellTimeout(120_000);
  });

  it('forwards search options and directory listings without local lookups', async () => {
    expect(
      (await execute(ToolNames.GLOB, { pattern: '**/*.txt' })).llmContent,
    ).toBe(remoteFile);
    expect(
      (
        await execute(ToolNames.GREP, {
          pattern: 'first',
          glob: '*.txt',
          limit: 5,
        })
      ).llmContent,
    ).toContain('Search truncated');
    expect(transport.request).toHaveBeenLastCalledWith(
      'grep',
      {
        path: remote,
        pattern: 'first',
        caseSensitive: false,
        glob: '*.txt',
        limit: 5,
      },
      expect.any(AbortSignal),
    );
    expect((await execute(ToolNames.LS, { path: remote })).llmContent).toBe(
      'file.txt\n[DIR] src',
    );
  });

  it.each([
    [ToolNames.SHELL, { command: 'pwd', is_background: true }],
    [ToolNames.SHELL, { command: 'pwd', timeout: 0 }],
    [ToolNames.READ_FILE, { file_path: 'file.txt', pages: '1-3' }],
    [ToolNames.LS, { path: remote, ignore: ['*.txt'] }],
    [ToolNames.NOTEBOOK_EDIT, {}],
    [ToolNames.TASK_STOP, {}],
  ])('rejects unsupported options for %s', async (toolName, params) => {
    await expect(
      prepare(toolName as string, params as Record<string, unknown>),
    ).rejects.toThrow();
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.execute).not.toHaveBeenCalled();
  });

  it('cancels an active SSH command on disposal and preserves uncertain status', async () => {
    transport.execute.mockImplementationOnce(
      (_command, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(
              new SshWorkspaceError(
                'cancelled',
                'The remote command may still be running; its status is uncertain.',
              ),
            ),
          );
        }),
    );
    const { id } = await prepare(ToolNames.SHELL, { command: 'sleep 100' });
    const executing = environment.execute(id, signal);
    const rejected = executing.catch((error: unknown) => error);
    await environment.dispose();
    expect(await rejected).toMatchObject({
      message: expect.stringContaining('status is uncertain'),
    });
    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(transport.dispose).toHaveBeenCalled();
  });

  it('honors cancellation, cache invalidation, release and disposal', async () => {
    await read();
    await environment.invalidateReadCache([`${anchor}/file.txt`]);
    await expectNeedsRead(ToolNames.WRITE_FILE, {
      file_path: remoteFile,
      content: 'overwrite',
    });
    const { id } = await prepare(ToolNames.SHELL, { command: 'pwd' });
    await environment.confirm(
      id,
      ToolConfirmationOutcome.Cancel,
      undefined,
      signal,
    );
    await expect(environment.execute(id, signal)).rejects.toThrow(
      'Unknown SSH tool',
    );
    const released = await prepare(ToolNames.READ_FILE, {
      file_path: 'file.txt',
    });
    await environment.release(released.id, signal);
    await expect(environment.execute(released.id, signal)).rejects.toThrow(
      'Unknown SSH tool',
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      environment.prepare(
        {
          id: 'aborted',
          toolName: ToolNames.READ_FILE,
          params: { file_path: 'file.txt' },
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    await environment.dispose();
    expect(transport.dispose).toHaveBeenCalled();
    await expect(read()).rejects.toThrow('disposed');
  });
  it.each([0, 2500])(
    'honors the configured output threshold %s and retains the tail',
    async (outputThreshold) => {
      await reconfigure({ outputThreshold });
      const content = 'head' + 'x'.repeat(20_000) + 'tail';
      files.set(remoteFile, content);
      const output = await read();
      expect(String(output.llmContent)).toContain('head');
      expect(String(output.llmContent)).toContain('tail');
      if (outputThreshold === 0) expect(output.llmContent).toBe(content);
      else {
        expect(String(output.llmContent).length).toBeLessThan(2700);
        expect(output.llmContent).toContain('truncated');
      }
    },
  );

  it.each([0, 45_000])(
    'uses the configured shell deadline %s unless the call overrides it',
    async (shellDefaultTimeoutMs) => {
      await reconfigure({ shellDefaultTimeoutMs });
      await execute(ToolNames.SHELL, { command: 'pwd' });
      expectShellTimeout(shellDefaultTimeoutMs);
      await execute(ToolNames.SHELL, { command: 'pwd', timeout: 1000 });
      expectShellTimeout(1000);
    },
  );

  it.each([-5000, 0.5, 2_147_483_648])(
    'falls back to the normal shell deadline for an invalid setting %s',
    async (shellDefaultTimeoutMs) => {
      await reconfigure({ shellDefaultTimeoutMs });
      await execute(ToolNames.SHELL, { command: 'pwd' });
      expectShellTimeout(120_000);
    },
  );

  it('extracts compound command roots after environment assignments for approval', async () => {
    const { id } = await prepare(ToolNames.SHELL, {
      command: 'FOO=1 npm test && git status',
    });
    expect(await environment.confirmation(id, signal)).toMatchObject({
      rootCommand: 'npm, git',
    });
  });

  it('offers reusable per-command rules and retains both shell and SSH warnings', async () => {
    const { id } = await prepare(ToolNames.SHELL, {
      command: 'npm install && npm run build',
    });
    expect(await environment.confirmation(id, signal)).toMatchObject({
      rootCommand: 'npm',
      permissionRules: ['Bash(npm install)', 'Bash(npm run *)'],
    });
    const substitution = await prepare(ToolNames.SHELL, {
      command: 'echo $(whoami)',
    });
    expect(
      await environment.confirmation(substitution.id, signal),
    ).toMatchObject({
      warnings: expect.arrayContaining([
        expect.stringContaining('command substitution'),
        expect.stringContaining('SSH host'),
      ]),
    });
  });

  it('invalidates every prior read when no paths are supplied', async () => {
    await read();
    await environment.invalidateReadCache();
    await expectNeedsRead(ToolNames.WRITE_FILE, {
      file_path: 'file.txt',
      content: 'bad',
    });
  });
  it('rejects a stale manual proposal independently of the current read hash', async () => {
    await read();
    await expect(
      prepare(
        ToolNames.WRITE_FILE,
        { file_path: 'file.txt', content: 'proposal' },
        'manual',
        {
          oldContent: 'stale rendered preview',
          newContent: 'manual replacement',
        },
      ),
    ).rejects.toThrow('file changed while modifying');
    expect(files.get(remoteFile)).toBe('first\r\nsecond\r\n');
    await expect(
      prepare(ToolNames.READ_FILE, { file_path: 'file.txt' }, 'manual-read', {
        oldContent: '',
        newContent: '',
      }),
    ).rejects.toThrow('does not support modification');
    expect(
      await environment.modificationContent(
        ToolNames.EDIT,
        { file_path: 'file.txt', old_string: 'first', new_string: 'revised' },
        signal,
      ),
    ).toEqual({
      current: 'first\r\nsecond\r\n',
      proposed: 'revised\r\nsecond\r\n',
    });
    await expect(
      environment.modificationContent(
        ToolNames.READ_FILE,
        { file_path: 'file.txt' },
        signal,
      ),
    ).rejects.toThrow('does not support modification');
  });
});
