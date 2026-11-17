/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { GrepTool } from '../tools/grep.js';
import { RipGrepTool } from '../tools/ripGrep.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { LocalExecutionEnvironment } from './local-execution-environment.js';

describe('LocalExecutionEnvironment', () => {
  let workspace: string;
  let config: Config;
  let environment: LocalExecutionEnvironment;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'execution-environment-'));
    config = new Config({
      targetDir: workspace,
      cwd: workspace,
      debugMode: false,
      telemetry: { enabled: false },
      deferTelemetryInitialization: true,
      shouldUseNodePtyShell: false,
    });
    environment = new LocalExecutionEnvironment(config);
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

  it('names an admitted tool with its parameter schema as its declaration', async () => {
    expect(environment.toolDefinition('read_file')).toEqual({
      name: 'read_file',
      description: expect.any(String),
      parametersJsonSchema: expect.anything(),
    });
    expect(
      (environment.toolDefinition('write_file') as { name: unknown }).name,
    ).toBe('write_file');
    expect(() => environment.toolDefinition('not_a_tool')).toThrow(
      'Unsupported execution tool',
    );
  });

  it("carries read_file's modality-derived description in its declaration", () => {
    // ReadFile recomputes its description from the model's current input
    // modalities on every schema access; the durable declaration publishes
    // the text the model actually saw.
    const textOnly = environment.toolDefinition('read_file') as {
      description: string;
    };
    expect(textOnly.description).not.toContain('watch a video');
    vi.spyOn(config, 'getEffectiveInputModalities').mockReturnValue({
      video: true,
    });
    const multimodal = environment.toolDefinition('read_file') as {
      description: string;
    };
    expect(multimodal.description).toContain('watch a video');
  });

  it('runs a prepared call elsewhere, with its final parameters', async () => {
    const file = path.join(workspace, 'file.txt');
    const run = vi.fn(async () => ({
      llmContent: 'ran elsewhere',
      returnDisplay: 'ran elsewhere',
    }));
    const elsewhere = new LocalExecutionEnvironment(
      new Config({
        targetDir: workspace,
        cwd: workspace,
        debugMode: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      }),
      { toolNames: new Set([ToolNames.WRITE_FILE]), run },
    );
    try {
      expect(elsewhere.toolNames).toEqual(new Set([ToolNames.WRITE_FILE]));
      await expect(
        elsewhere.prepare(
          { id: 'shell', toolName: ToolNames.SHELL, params: { command: 'ls' } },
          signal,
        ),
      ).rejects.toThrow('Unsupported execution tool');
      // A modification the user made changes the parameters it prepares.
      await elsewhere.prepare(
        {
          id: 'write',
          toolName: ToolNames.WRITE_FILE,
          params: { file_path: file, content: 'proposed\n' },
          modification: { oldContent: '', newContent: 'modified\n' },
        },
        signal,
      );
      const result = await elsewhere.execute('write', signal);
      expect(result.llmContent).toBe('ran elsewhere');
      expect(run).toHaveBeenCalledExactlyOnceWith(
        {
          id: 'write',
          toolName: ToolNames.WRITE_FILE,
          params: expect.objectContaining({
            file_path: file,
            content: 'modified\n',
          }),
        },
        expect.any(AbortSignal),
        undefined,
      );
      // The prepared invocation never ran here.
      await expect(readFile(file, 'utf8')).rejects.toThrow();
    } finally {
      await elsewhere.dispose();
    }
  });

  it("hands the scheduler's call id to the runner when the call carries one", async () => {
    const run = vi.fn(async () => ({
      llmContent: 'ran elsewhere',
      returnDisplay: 'ran elsewhere',
    }));
    const elsewhere = new LocalExecutionEnvironment(
      new Config({
        targetDir: workspace,
        cwd: workspace,
        debugMode: false,
        telemetry: { enabled: false },
        deferTelemetryInitialization: true,
      }),
      { toolNames: new Set([ToolNames.WRITE_FILE]), run },
    );
    try {
      await elsewhere.prepare(
        {
          id: 'invocation-1',
          callId: 'model-call-1',
          toolName: ToolNames.WRITE_FILE,
          params: { file_path: path.join(workspace, 'f.txt'), content: 'x' },
        },
        signal,
      );
      await elsewhere.execute('invocation-1', signal);
      expect(run).toHaveBeenCalledExactlyOnceWith(
        {
          id: 'invocation-1',
          callId: 'model-call-1',
          toolName: ToolNames.WRITE_FILE,
          params: expect.objectContaining({
            file_path: path.join(workspace, 'f.txt'),
          }),
        },
        expect.any(AbortSignal),
        undefined,
      );
    } finally {
      await elsewhere.dispose();
    }
  });

  // Windows does not unescape paths.
  it.skipIf(process.platform === 'win32')(
    'does not run elsewhere what a second build would change',
    async () => {
      const run = vi.fn();
      const elsewhere = new LocalExecutionEnvironment(
        new Config({
          targetDir: workspace,
          cwd: workspace,
          debugMode: false,
          telemetry: { enabled: false },
          deferTelemetryInitialization: true,
        }),
        { toolNames: new Set([ToolNames.WRITE_FILE]), run },
      );
      try {
        // Unescaped once here it names `prod\ settings.json`; a second
        // build, where the call runs, would name `prod settings.json`.
        await elsewhere.prepare(
          {
            id: 'write',
            toolName: ToolNames.WRITE_FILE,
            params: {
              file_path: path.join(workspace, 'prod\\\\ settings.json'),
              content: 'x',
            },
          },
          signal,
        );
        await expect(elsewhere.execute('write', signal)).rejects.toThrow(
          'did not run',
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        await elsewhere.dispose();
      }
    },
  );

  it('preserves prior-read enforcement across invocations and rejects a missing stale target', async () => {
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
      old_string: 'after',
      new_string: 'lost',
    });
    expect(stale.error?.type).toBe('file_changed_since_read');
    expect(stale.llmContent).toContain('mtime or size changed');
    expect(await readFile(file, 'utf8')).toBe('externally changed\n');
  });

  it.each(['full', 'partial', 'partial-then-full'])(
    'keeps consecutive Edits in recovery until an actual text Read (read=%s)',
    async (readMode) => {
      const file = path.join(workspace, 'recovered.txt');
      await writeFile(file, 'header-v1\ntarget\n');
      const initialRead = await execute('read', ToolNames.READ_FILE, {
        file_path: file,
        ...(readMode === 'full' ? {} : { offset: 1, limit: 1 }),
      });
      expect(initialRead.error).toBeUndefined();
      expect(initialRead.llmContent).toContain('target');
      const initialCache = config.getFileReadCache().check(await stat(file));
      expect(initialCache.state).toBe('fresh');
      if (initialCache.state === 'fresh') {
        expect(initialCache.entry.lastReadWasFull).toBe(readMode === 'full');
      }
      if (readMode !== 'full') {
        expect(initialRead.llmContent).not.toContain('header-v1');
      }
      await writeFile(file, 'external-header-v2\ntarget\n');
      const result = await execute('recover', ToolNames.EDIT, {
        file_path: file,
        old_string: 'target',
        new_string: 'updated',
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('recovery checks');
      expect(await readFile(file, 'utf8')).toBe(
        'external-header-v2\nupdated\n',
      );
      const followup = await execute('followup', ToolNames.EDIT, {
        file_path: file,
        old_string: 'updated',
        new_string: 'again',
      });
      expect(followup.error).toBeUndefined();
      expect(followup.llmContent).toContain('recovery checks');
      const third = await execute('third', ToolNames.EDIT, {
        file_path: file,
        old_string: 'again',
        new_string: 'third',
      });
      expect(third.error).toBeUndefined();
      expect(third.llmContent).toContain('recovery checks');
      if (readMode === 'full') {
        const fileSystem = config.getFileSystemService();
        const originalRead = fileSystem.withReadFile;
        fileSystem.withReadFile = async () => {
          throw new Error('read unavailable');
        };
        try {
          await expect(
            execute('failed-read', ToolNames.READ_FILE, { file_path: file }),
          ).rejects.toThrow('read unavailable');
        } finally {
          fileSystem.withReadFile = originalRead;
        }
      }
      const overwrite = await execute('overwrite', ToolNames.WRITE_FILE, {
        file_path: file,
        content: 'header-v1\nupdated\n',
      });
      expect(overwrite.error?.type).toBe('file_changed_since_read');
      expect(overwrite.llmContent).toContain('Read baseline');
      expect(overwrite.llmContent).not.toContain('mtime or size changed');
      expect(await readFile(file, 'utf8')).toBe('external-header-v2\nthird\n');
      const partial = await execute('partial', ToolNames.READ_FILE, {
        file_path: file,
        ...(readMode === 'full' ? {} : { offset: 1, limit: 1 }),
      });
      expect(partial.error).toBeUndefined();
      if (readMode === 'partial-then-full') {
        const full = await execute('full', ToolNames.READ_FILE, {
          file_path: file,
        });
        expect(full.llmContent).toContain('external-header-v2');
        expect(full.llmContent).not.toContain('unchanged since last read');
      }
      const allowed = await execute('allowed', ToolNames.WRITE_FILE, {
        file_path: file,
        content: 'external-header-v2\nfinal\n',
      });
      expect(allowed.error).toBeUndefined();
      expect(await readFile(file, 'utf8')).toBe('external-header-v2\nfinal\n');
    },
  );

  it.each([
    ['Grep', GrepTool],
    ['RipGrep', RipGrepTool],
  ] as const)(
    'keeps the recovery baseline after %s results',
    async (_name, SearchTool) => {
      const file = path.join(workspace, 'grep-baseline.txt');
      await writeFile(file, 'original header\ntarget\n');
      await execute('read', ToolNames.READ_FILE, { file_path: file });
      await writeFile(file, 'unseen external header\ntarget\n');
      const recovered = await execute('recover', ToolNames.EDIT, {
        file_path: file,
        old_string: 'target',
        new_string: 'updated',
      });
      expect(recovered.error).toBeUndefined();
      const search = new SearchTool(config);
      const found = await search
        .build({ pattern: 'updated', path: workspace })
        .execute(signal);
      expect(found.error).toBeUndefined();
      expect(found.llmContent).toContain('updated');
      expect(found.llmContent).not.toContain('unseen external header');
      const overwrite = await execute('overwrite', ToolNames.WRITE_FILE, {
        file_path: file,
        content: 'original header\nupdated\n',
      });
      expect(overwrite.error?.type).toBe('file_changed_since_read');
      expect(overwrite.llmContent).toContain('Read baseline');
      expect(await readFile(file, 'utf8')).toBe(
        'unseen external header\nupdated\n',
      );
      const next = await execute('next', ToolNames.EDIT, {
        file_path: file,
        old_string: 'updated',
        new_string: 'again',
      });
      expect(next.error).toBeUndefined();
      expect(next.llmContent).toContain('recovery checks');
      expect(await readFile(file, 'utf8')).toBe(
        'unseen external header\nagain\n',
      );
      const partial = await execute('partial', ToolNames.READ_FILE, {
        file_path: file,
        offset: 1,
        limit: 1,
      });
      expect(partial.error).toBeUndefined();
      const allowed = await execute('allowed', ToolNames.WRITE_FILE, {
        file_path: file,
        content: 'unseen external header\nfinal\n',
      });
      expect(allowed.error).toBeUndefined();

      const ordinary = path.join(workspace, 'ordinary.txt');
      await writeFile(ordinary, 'ordinary match\n');
      const ordinarySearch = await search
        .build({ pattern: 'ordinary match', path: workspace })
        .execute(signal);
      expect(ordinarySearch.error).toBeUndefined();
      expect(ordinarySearch.llmContent).toContain('ordinary match');
      const ordinaryWrite = await execute(
        'ordinary-write',
        ToolNames.WRITE_FILE,
        {
          file_path: ordinary,
          content: 'ordinary replacement\n',
        },
      );
      expect(ordinaryWrite.error).toBeUndefined();
      expect(await readFile(ordinary, 'utf8')).toBe('ordinary replacement\n');
    },
  );

  it.each([
    ['snippet', false],
    ['snippet', true],
    ['omitted', false],
    ['omitted', true],
  ] as const)(
    'reads user-modified content after %s output (partial first=%s)',
    async (output, partialFirst) => {
      const file = path.join(workspace, 'user-modified.txt');
      const original = 'header\nold\nfooter\n';
      const replacement =
        output === 'snippet'
          ? 'user change'
          : Array.from(
              { length: 100 },
              (_, i) => `user change ${i} ${'x'.repeat(90)}`,
            ).join('\n');
      const modified = `header\n${replacement}\nfooter\n`;
      await writeFile(file, original);
      await execute('read', ToolNames.READ_FILE, { file_path: file });
      const prepared = await environment.prepare(
        {
          id: 'modified',
          toolName: ToolNames.EDIT,
          params: {
            file_path: file,
            old_string: 'old',
            new_string: 'model change',
          },
          modification: { oldContent: original, newContent: modified },
        },
        signal,
      );
      expect(prepared.params).toMatchObject({
        modified_by_user: true,
        old_string: original,
        new_string: modified,
      });
      const result = await environment.execute('modified', signal);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('User modified');
      expect(result.llmContent).toContain(
        output === 'snippet' ? 'Showing lines' : 'Use Read',
      );
      expect(await readFile(file, 'utf8')).toBe(modified);
      const written = config.getFileReadCache().check(await stat(file));
      expect(written.state).toBe('fresh');
      if (written.state !== 'fresh')
        throw new Error('Missing write cache entry');
      const writeTime = written.entry.lastWriteAt!;
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(writeTime));
      if (partialFirst) {
        const partial = await execute('partial', ToolNames.READ_FILE, {
          file_path: file,
          offset: 0,
          limit: 1,
        });
        expect(partial.error).toBeUndefined();
        expect(partial.llmContent).toContain('header');
        expect(partial.llmContent).not.toContain('user change');
        expect(written.entry.lastReadAt).toBeGreaterThan(writeTime);
      }
      const full = await execute('full', ToolNames.READ_FILE, {
        file_path: file,
      });
      expect(full.error).toBeUndefined();
      expect(full.llmContent).toContain(replacement);
      expect(full.llmContent).not.toContain('unchanged since last read');
      const cached = await execute('cached', ToolNames.READ_FILE, {
        file_path: file,
      });
      expect(cached.llmContent).toContain('unchanged since last read');
    },
  );

  it('keeps simulated sed behind the recovered Read baseline until a text Read', async () => {
    const file = path.join(workspace, 'sed-baseline.txt');
    await writeFile(file, 'header-v1\ntarget\n');
    await execute('read', ToolNames.READ_FILE, { file_path: file });
    await writeFile(file, 'external-header-v2\ntarget\n');
    const recovered = await execute('recover', ToolNames.EDIT, {
      file_path: file,
      old_string: 'target',
      new_string: 'updated',
    });
    expect(recovered.error).toBeUndefined();
    const cache = config.getFileReadCache().check(await stat(file));
    expect(cache.state).toBe('fresh');
    if (cache.state === 'fresh') {
      expect(cache.entry.readBaselineNeedsRefresh).toBe(true);
    }

    const params = {
      command: "sed -i 's/updated/final/' sed-baseline.txt",
      directory: workspace,
    };
    await environment.prepare(
      { id: 'sed-rejected', toolName: ToolNames.SHELL, params },
      signal,
    );
    await expect(
      environment.confirmation('sed-rejected', signal),
    ).rejects.toMatchObject({ errorType: 'file_changed_since_read' });
    const rejected = await environment.execute('sed-rejected', signal);
    expect(rejected.error?.type).toBe('file_changed_since_read');
    expect(rejected.llmContent).toContain('Read baseline');
    expect(rejected.llmContent).not.toContain('mtime or size changed');
    expect(await readFile(file, 'utf8')).toBe('external-header-v2\nupdated\n');

    const reread = await execute('partial-read', ToolNames.READ_FILE, {
      file_path: file,
      offset: 1,
      limit: 1,
    });
    expect(reread.error).toBeUndefined();
    await environment.prepare(
      { id: 'sed-allowed', toolName: ToolNames.SHELL, params },
      signal,
    );
    expect((await environment.confirmation('sed-allowed', signal)).type).toBe(
      'edit',
    );
    await environment.confirm(
      'sed-allowed',
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
      signal,
    );
    const allowed = await environment.execute('sed-allowed', signal);
    expect(allowed.error).toBeUndefined();
    expect(allowed.llmContent).toContain('sed edit applied');
    expect(await readFile(file, 'utf8')).toBe('external-header-v2\nfinal\n');
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
      command: `node -e "process.stdout.write('worker-ok')"`,
      is_background: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('worker-ok');
    await environment.prepare(
      {
        id: 'cancel',
        toolName: ToolNames.SHELL,
        params: {
          command: `node -e "console.log('started'); setTimeout(function(){}, 30000)"`,
          is_background: false,
        },
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
