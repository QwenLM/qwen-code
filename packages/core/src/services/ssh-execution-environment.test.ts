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
  let nextId = 0;
  const hash = (content: string) =>
    `sha256:${createHash('sha256').update(content).digest('hex')}`;

  beforeEach(() => {
    vi.clearAllMocks();
    files = new Map([[`${remote}/file.txt`, 'first\r\nsecond\r\n']]);
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
        return { paths: [`${remote}/file.txt`], truncated: false };
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

  async function prepare(
    toolName: string,
    params: Record<string, unknown>,
    id = String(nextId++),
  ) {
    const prepared = await environment.prepare(
      { id, toolName, params },
      signal,
    );
    return { id, prepared };
  }

  async function execute(toolName: string, params: Record<string, unknown>) {
    const { id } = await prepare(toolName, params);
    return environment.execute(id, signal);
  }

  async function read(filePath = `${remote}/file.txt`) {
    return execute(ToolNames.READ_FILE, { file_path: filePath });
  }

  it.each(['file.txt', `${remote}/file.txt`, `${anchor}/file.txt`])(
    'reads the same remote file for path %s without touching the anchor',
    async (filePath) => {
      const output = await read(filePath);
      expect(output.llmContent).toBe('first\r\nsecond\r\n');
      expect(transport.request).toHaveBeenCalledWith(
        'read',
        { path: `${remote}/file.txt` },
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
      file_path: `${remote}/file.txt`,
      old_string: 'first',
      new_string: 'edited',
    };
    await expect(prepare(ToolNames.EDIT, params)).rejects.toThrow(
      'Read the remote file',
    );
    await read();
    files.set(`${remote}/file.txt`, 'first changed');
    await expect(prepare(ToolNames.EDIT, params)).rejects.toThrow(
      'changed since the last read',
    );
    expect(files.get(`${remote}/file.txt`)).toBe('first changed');
  });

  it('returns the real preview before approval and uses CAS when executing', async () => {
    await read();
    const { id } = await prepare(ToolNames.EDIT, {
      file_path: `${remote}/file.txt`,
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
    expect(files.get(`${remote}/file.txt`)).toBe('first\r\nsecond\r\n');
    await environment.confirm(
      id,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      signal,
    );
    await environment.execute(id, signal);
    expect(files.get(`${remote}/file.txt`)).toBe('$& edited\r\nsecond\r\n');
    expect(transport.request).toHaveBeenLastCalledWith(
      'write',
      {
        path: `${remote}/file.txt`,
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
      file_path: `${remote}/file.txt`,
      content: 'proposal',
    });
    await environment.confirm(
      id,
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      signal,
    );
    files.set(`${remote}/file.txt`, 'external write');
    await expect(environment.execute(id, signal)).rejects.toThrow(
      'hash_mismatch',
    );
    expect(files.get(`${remote}/file.txt`)).toBe('external write');
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
    const file = `${remote}/file.txt`;
    files.set(file, '\uFEFFfirst\r\nsecond\r\n');
    await read(file);
    await environment.prepare(
      {
        id: 'formatted-modification',
        toolName: ToolNames.EDIT,
        params: {
          file_path: file,
          old_string: 'first',
          new_string: 'proposal',
        },
        modification: {
          oldContent: '\uFEFFfirst\r\nsecond\r\n',
          newContent: 'manual\nproposal\n',
        },
      },
      signal,
    );
    expect(
      await environment.confirmation('formatted-modification', signal),
    ).toMatchObject({
      newContent: '\uFEFFmanual\r\nproposal\r\n',
    });
    await environment.confirm(
      'formatted-modification',
      ToolConfirmationOutcome.ProceedOnce,
      { newContent: '\uFEFFfinal\ncontent\n' },
      signal,
    );
    await environment.execute('formatted-modification', signal);
    expect(files.get(file)).toBe('\uFEFFfinal\r\ncontent\r\n');
  });

  it('honors manually edited proposals and confirmation payloads', async () => {
    await read();
    await environment.prepare(
      {
        id: 'modified',
        toolName: ToolNames.EDIT,
        params: {
          file_path: `${remote}/file.txt`,
          old_string: 'first',
          new_string: 'proposal',
        },
        modification: {
          oldContent: 'first\r\nsecond\r\n',
          newContent: 'manually edited',
        },
      },
      signal,
    );
    expect(await environment.confirmation('modified', signal)).toMatchObject({
      originalContent: 'first\r\nsecond\r\n',
      newContent: 'manually edited',
    });
    await environment.confirm(
      'modified',
      ToolConfirmationOutcome.ProceedOnce,
      { newContent: 'final reviewed content' },
      signal,
    );
    await environment.execute('modified', signal);
    expect(files.get(`${remote}/file.txt`)).toBe('final reviewed content');
  });

  it('does not allow modified_by_user to bypass prior reading', async () => {
    await expect(
      prepare(ToolNames.WRITE_FILE, {
        file_path: `${remote}/file.txt`,
        content: 'overwrite',
        modified_by_user: true,
      }),
    ).rejects.toThrow('Read the remote file');
  });

  it('requires unique edit matches unless replace_all is requested', async () => {
    files.set(`${remote}/file.txt`, 'same same');
    await read();
    const params = {
      file_path: `${remote}/file.txt`,
      old_string: 'same',
      new_string: 'new',
    };
    await expect(prepare(ToolNames.EDIT, params)).rejects.toThrow(
      'multiple locations',
    );
    await execute(ToolNames.EDIT, { ...params, replace_all: true });
    expect(files.get(`${remote}/file.txt`)).toBe('new new');
  });

  it('allows editing large files after a paginated read while preserving unseen content', async () => {
    const prefix = 'first line\r\n'.repeat(3000);
    const original = `${prefix}target line\r\nlast line\r\n`;
    files.set(`${remote}/file.txt`, original);
    expect(
      (
        await execute(ToolNames.READ_FILE, {
          file_path: `${remote}/file.txt`,
          offset: 3000,
          limit: 1,
        })
      ).llmContent,
    ).toBe('target line\r');
    await execute(ToolNames.EDIT, {
      file_path: `${remote}/file.txt`,
      old_string: 'target line',
      new_string: 'updated line',
    });
    expect(files.get(`${remote}/file.txt`)).toBe(
      `${prefix}updated line\r\nlast line\r\n`,
    );
    expect(transport.request).toHaveBeenLastCalledWith(
      'write',
      expect.objectContaining({ expectedHash: hash(original) }),
      expect.any(AbortSignal),
    );
  });

  it('bounds large read output and retains prior-read protection for overwrites', async () => {
    files.set(`${remote}/file.txt`, 'x'.repeat(40_000));
    const output = await read();
    expect(String(output.llmContent).length).toBeLessThan(25_000);
    expect(output.llmContent).toContain('truncated');
    expect(output.outputBudgetApplied).toBe(true);
    expect(output.resultFilePaths).toEqual([]);
    await execute(ToolNames.WRITE_FILE, {
      file_path: `${remote}/file.txt`,
      content: 'overwrite',
    });
    expect(files.get(`${remote}/file.txt`)).toBe('overwrite');
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
    await expect(
      prepare(ToolNames.WRITE_FILE, {
        file_path: `${remote}/file.txt`,
        content: 'overwrite',
      }),
    ).rejects.toThrow('Read the remote file');
  });

  it('uses the normal two-minute foreground shell timeout by default', async () => {
    await execute(ToolNames.SHELL, { command: 'pwd' });
    expect(transport.execute).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('forwards search options and directory listings without local lookups', async () => {
    expect(
      (await execute(ToolNames.GLOB, { pattern: '**/*.txt' })).llmContent,
    ).toBe(`${remote}/file.txt`);
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
    await expect(
      prepare(ToolNames.WRITE_FILE, {
        file_path: `${remote}/file.txt`,
        content: 'overwrite',
      }),
    ).rejects.toThrow('Read the remote file');
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
      await environment.dispose();
      environment = new SshExecutionEnvironment(
        { host: 'host', directory: remote },
        anchor,
        { outputThreshold },
      );
      const content = 'head' + 'x'.repeat(20_000) + 'tail';
      files.set(`${remote}/file.txt`, content);
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
      await environment.dispose();
      environment = new SshExecutionEnvironment(
        { host: 'host', directory: remote },
        anchor,
        { shellDefaultTimeoutMs },
      );
      await execute(ToolNames.SHELL, { command: 'pwd' });
      expect(transport.execute).toHaveBeenLastCalledWith(
        'pwd',
        expect.objectContaining({ timeoutMs: shellDefaultTimeoutMs }),
      );
      await execute(ToolNames.SHELL, { command: 'pwd', timeout: 1000 });
      expect(transport.execute).toHaveBeenLastCalledWith(
        'pwd',
        expect.objectContaining({ timeoutMs: 1000 }),
      );
    },
  );

  it.each([-5000, 0.5, 2_147_483_648])(
    'falls back to the normal shell deadline for an invalid setting %s',
    async (shellDefaultTimeoutMs) => {
      await environment.dispose();
      environment = new SshExecutionEnvironment(
        { host: 'host', directory: remote },
        anchor,
        { shellDefaultTimeoutMs },
      );
      await execute(ToolNames.SHELL, { command: 'pwd' });
      expect(transport.execute).toHaveBeenLastCalledWith(
        'pwd',
        expect.objectContaining({ timeoutMs: 120_000 }),
      );
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
    await expect(
      prepare(ToolNames.WRITE_FILE, { file_path: 'file.txt', content: 'bad' }),
    ).rejects.toThrow('Read the remote file');
  });
  it('rejects a stale manual proposal independently of the current read hash', async () => {
    await read();
    await expect(
      environment.prepare(
        {
          id: 'manual',
          toolName: ToolNames.WRITE_FILE,
          params: { file_path: 'file.txt', content: 'proposal' },
          modification: {
            oldContent: 'stale rendered preview',
            newContent: 'manual replacement',
          },
        },
        signal,
      ),
    ).rejects.toThrow('file changed while modifying');
    expect(files.get(`${remote}/file.txt`)).toBe('first\r\nsecond\r\n');
    await expect(
      environment.prepare(
        {
          id: 'manual-read',
          toolName: ToolNames.READ_FILE,
          params: { file_path: 'file.txt' },
          modification: { oldContent: '', newContent: '' },
        },
        signal,
      ),
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
