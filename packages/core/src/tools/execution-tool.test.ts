/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { LocalExecutionEnvironment } from '../services/local-execution-environment.js';
import { EditTool } from './edit.js';
import { wrapExecutionTool } from './execution-tool.js';
import { isModifiableDeclarativeTool } from './modifiable-tool.js';
import { NotebookEditTool } from './notebook-edit.js';
import { ReadFileTool } from './read-file.js';
import { WriteFileTool } from './write-file.js';
import { ToolNames } from './tool-names.js';
import { ToolConfirmationOutcome } from './tools.js';

describe('execution tool facade', () => {
  let workspace: string;
  let config: Config;
  let environment: LocalExecutionEnvironment;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'execution-tool-'));
    const options = {
      targetDir: workspace,
      cwd: workspace,
      debugMode: false,
      telemetry: { enabled: false },
      deferTelemetryInitialization: true,
    };
    config = new Config(options);
    environment = new LocalExecutionEnvironment(new Config(options));
  });

  afterEach(async () => {
    await environment.dispose();
    await rm(workspace, { recursive: true, force: true });
  });

  it('preserves schema and classifier metadata while never calling host build or filesystem', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'before\n');
    const original = new ReadFileTool(config);
    const hostBuild = vi.spyOn(original, 'build').mockImplementation(() => {
      throw new Error('host build must not run');
    });
    const hostFs = vi
      .spyOn(config, 'getFileSystemService')
      .mockImplementation(() => {
        throw new Error('host fs must not run');
      });
    const facade = wrapExecutionTool(original, environment, config);
    expect(facade.schema).toEqual(original.schema);
    expect(facade.maxOutputChars).toBe(original.maxOutputChars);
    const invocation = facade.build({ file_path: file });
    expect(await invocation.getDefaultPermission()).toBe('allow');
    expect(invocation.toolLocations()).toEqual([{ path: file }]);
    const result = await invocation.execute(signal);
    expect(result.llmContent).toContain('before');
    expect(result.persistedOutputFiles).toEqual([]);
    expect(result.resultFilePaths).toEqual([]);
    expect(hostBuild).not.toHaveBeenCalled();
    expect(hostFs).not.toHaveBeenCalled();
    const edit = new EditTool(config);
    expect(
      wrapExecutionTool(edit, environment, config).toAutoClassifierInput({
        file_path: file,
        new_string: 'after',
      }),
    ).toEqual(
      edit.toAutoClassifierInput({
        file_path: file,
        old_string: '',
        new_string: 'after',
      }),
    );
  });

  it('propagates host cache clears before the next execution', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'read me\n');
    const facade = wrapExecutionTool(
      new ReadFileTool(config),
      environment,
      config,
    );
    await facade.build({ file_path: file }).execute(signal);
    expect(
      (await facade.build({ file_path: file }).execute(signal)).llmContent,
    ).toContain('unchanged since last read');
    config.getFileReadCache().clear();
    expect(
      (await facade.build({ file_path: file }).execute(signal)).llmContent,
    ).toContain('read me');
  });

  it('retries failed invalidation before preparing another invocation', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'read me');
    const facade = wrapExecutionTool(
      new ReadFileTool(config),
      environment,
      config,
    );
    await facade.build({ file_path: file }).execute(signal);
    config.getFileReadCache().clear();
    const invalidate = vi
      .spyOn(environment, 'invalidateReadCache')
      .mockRejectedValueOnce(new Error('failed invalidation'));
    const prepare = vi.spyOn(environment, 'prepare');
    await expect(
      facade.build({ file_path: file }).execute(signal),
    ).rejects.toThrow('failed invalidation');
    expect(prepare).not.toHaveBeenCalled();
    expect(
      (await facade.build({ file_path: file }).execute(signal)).llmContent,
    ).toContain('read me');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each(['caller abort', 'release'])(
    'cancels pending permission preparation on %s',
    async (action) => {
      let prepareSignal!: AbortSignal;
      vi.spyOn(environment, 'prepare').mockImplementation(
        (_request, signal) =>
          new Promise((_resolve, reject) => {
            prepareSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      const release = vi.spyOn(environment, 'release');
      const invocation = wrapExecutionTool(
        new ReadFileTool(config),
        environment,
        config,
      ).build({ file_path: path.join(workspace, 'file.txt') });
      const controller = new AbortController();
      const permission = invocation.getDefaultPermission(controller.signal);
      const rejected = permission.catch((error: unknown) => error);
      await vi.waitFor(() => expect(prepareSignal).toBeDefined());
      if (action === 'caller abort') controller.abort();
      else await invocation.release?.();
      expect(await rejected).toBe(prepareSignal.reason);
      await invocation.release?.();
      expect(prepareSignal.aborted).toBe(true);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it('routes the retained editor confirmation callback to the rebuilt invocation', async () => {
    const file = path.join(workspace, 'edited.txt');
    const facade = wrapExecutionTool(
      new WriteFileTool(config),
      environment,
      config,
    );
    const first = facade.build({
      file_path: file,
      content: 'initial',
    }) as ReturnType<typeof facade.build> & { setCallId(id: string): void };
    first.setCallId('editor-call');
    const confirmation = await first.getConfirmationDetails(signal);
    await confirmation.onConfirm(ToolConfirmationOutcome.ModifyWithEditor);
    const updated = facade.build({
      file_path: file,
      content: 'user edit',
    }) as typeof first;
    updated.setCallId('editor-call');
    await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect((await updated.execute(signal)).error).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('user edit');
    const release = vi.spyOn(environment, 'release');
    await updated.release?.();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not promote worker-owned paths to host artifacts or control metadata', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'content');
    vi.spyOn(environment, 'execute').mockResolvedValueOnce({
      llmContent: 'remote result',
      returnDisplay: 'remote result',
      persistedOutputFiles: ['/host/private'],
      resultFilePaths: ['/host/private'],
      artifacts: [
        {
          storage: 'workspace',
          title: 'untrusted',
          workspacePath: '/host/private',
        },
      ],
      modelOverride: 'untrusted-model',
      terminateTurn: true,
    });
    const facade = wrapExecutionTool(
      new ReadFileTool(config),
      environment,
      config,
    );
    expect(await facade.build({ file_path: file }).execute(signal)).toEqual({
      llmContent: 'remote result',
      returnDisplay: 'remote result',
      persistedOutputFiles: [],
      resultFilePaths: [],
    });
  });

  it.each([false, true])(
    'scopes cloned notebook edits to their call (abandoned=%s)',
    async (abandoned) => {
      const file = path.join(workspace, 'test.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            id: 'one',
            metadata: {},
            source: ['print(1)'],
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      };
      await writeFile(file, JSON.stringify(notebook));
      const read = wrapExecutionTool(
        new ReadFileTool(config),
        environment,
        config,
      );
      expect(
        (await read.build({ file_path: file }).execute(signal)).error,
      ).toBeUndefined();
      const facade = wrapExecutionTool(
        new NotebookEditTool(config),
        environment,
        config,
      );
      if (!isModifiableDeclarativeTool(facade))
        throw new Error('Missing modify context');
      const params = {
        notebook_path: file,
        cell_id: 'one',
        new_source: 'print(2)',
      };
      const first = facade.build(params) as ReturnType<typeof facade.build> & {
        setCallId(id: string): void;
      };
      first.setCallId('notebook-call');
      const context = facade.getModifyContext(signal, 'notebook-call');
      const oldContent = await context.getCurrentContent(params);
      const proposed = JSON.parse(await context.getProposedContent(params));
      proposed.cells[0].source = ['print(3)'];
      const updated = context.createUpdatedParams(
        oldContent,
        JSON.stringify(proposed),
        params,
      );
      if (abandoned) await first.release?.();
      const invocation = facade.build(structuredClone(updated)) as typeof first;
      invocation.setCallId(abandoned ? 'later-call' : 'notebook-call');
      const confirmation = await invocation.getConfirmationDetails(signal);
      expect(confirmation.type).toBe('edit');
      await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
      const result = await invocation.execute(signal);
      expect(result.error).toBeUndefined();
      expect(JSON.parse(await readFile(file, 'utf8')).cells[0].source).toEqual([
        abandoned ? 'print(2)' : 'print(3)',
      ]);
      expect(result.returnDisplay).toMatchObject({
        newContent: expect.stringContaining(
          abandoned ? 'print(2)' : 'print(3)',
        ),
      });
      await environment.prepare(
        { id: 'later', toolName: ToolNames.NOTEBOOK_EDIT, params },
        signal,
      );
      await environment.release('later', signal);
    },
  );
});
