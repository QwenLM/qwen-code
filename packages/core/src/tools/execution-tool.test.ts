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
import { createExecutionWorkerEnvironment } from '../services/execution-worker.js';
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

  it.each([true, false])(
    'reports the container artifact limit without changing local registration (%s)',
    async (artifactEnabled) => {
      vi.spyOn(config, 'isRecordArtifactEnabled').mockReturnValue(
        artifactEnabled,
      );
      await environment.dispose();
      environment = createExecutionWorkerEnvironment({
        workspace,
        sessionId: 'artifact-test',
        truncateToolOutputLines: 100,
        fileReadCacheDisabled: false,
      });
      const original = new WriteFileTool(config);
      const facade = wrapExecutionTool(original, environment, config);
      const content = '<h1>Report</h1>';
      const local = await original
        .build({ file_path: path.join(workspace, 'local.html'), content })
        .execute(signal);
      const remoteFile = path.join(workspace, 'remote.html');
      const remote = await facade
        .build({ file_path: remoteFile, content })
        .execute(signal);
      expect(local.error).toBeUndefined();
      expect(local.artifacts?.length ?? 0).toBe(artifactEnabled ? 1 : 0);
      expect(String(local.llmContent).includes('automatically recorded')).toBe(
        artifactEnabled,
      );
      expect(remote.error).toBeUndefined();
      expect(remote.llmContent).toContain('Successfully created');
      expect(remote.llmContent).not.toContain('automatically recorded');
      expect(remote.artifacts).toBeUndefined();
      expect(await readFile(remoteFile, 'utf8')).toBe(content);
      expect(facade.description).not.toContain(
        'automatically registered as session artifacts',
      );
      expect(facade.description).toContain(
        'Automatic session artifact registration is unavailable',
      );
      expect(facade.description).toContain('prior-read enforcement');
      expect(facade.schema.description).toBe(facade.description);
      expect(facade.schema.parametersJsonSchema).toEqual(
        original.schema.parametersJsonSchema,
      );
      expect(config.isRecordArtifactEnabled()).toBe(artifactEnabled);
    },
  );

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

  it.each([
    ['prepare', 'caller abort'],
    ['prepare', 'release'],
    ['prepare', 'release without caller signal'],
    ['permission', 'caller abort'],
    ['permission', 'release'],
    ['permission', 'release without caller signal'],
  ] as const)('cancels pending %s on %s', async (phase, action) => {
    let pendingSignal!: AbortSignal;
    vi.spyOn(environment, phase).mockImplementation(
      (_request, signal) =>
        new Promise<never>((_resolve, reject) => {
          pendingSignal = signal;
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
    const permission = invocation.getDefaultPermission(
      action === 'release without caller signal'
        ? undefined
        : controller.signal,
    );
    const rejected = permission.catch((error: unknown) => error);
    await vi.waitFor(() => expect(pendingSignal).toBeDefined());
    if (action === 'caller abort') controller.abort();
    else await invocation.release?.();
    expect(await rejected).toBe(pendingSignal.reason);
    await invocation.release?.();
    expect(pendingSignal.aborted).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases a no-argument permission denial exactly once', async () => {
    vi.spyOn(environment, 'permission').mockResolvedValue('deny');
    const release = vi.spyOn(environment, 'release');
    const invocation = wrapExecutionTool(
      new ReadFileTool(config),
      environment,
      config,
    ).build({ file_path: path.join(workspace, 'file.txt') });
    expect(await invocation.getDefaultPermission()).toBe('deny');
    await invocation.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds release when a cancelled permission request also loses its cleanup reply', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'content');
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    const timeoutError = new Error('release timed out');
    let permissionSignal!: AbortSignal;
    let releaseSignal!: AbortSignal;
    let rejectRelease: ((error: Error) => void) | undefined;
    const permission = vi.spyOn(environment, 'permission').mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          permissionSignal = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const release = vi.spyOn(environment, 'release').mockImplementation(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          releaseSignal = signal;
          rejectRelease = reject;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const invocation = wrapExecutionTool(
      new ReadFileTool(config),
      environment,
      config,
    ).build({ file_path: file });
    const controller = new AbortController();
    const cancelled = invocation
      .getDefaultPermission(controller.signal)
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
      controller.abort();
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(releaseSignal.aborted).toBe(false);
      deadline.abort(timeoutError);
      expect(await cancelled).toBe(permissionSignal.reason);
      await expect(invocation.release!()).rejects.toBe(timeoutError);
    } finally {
      rejectRelease?.(timeoutError);
      await cancelled;
      timeout.mockRestore();
    }
  });

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

  it('preserves output sizing while filtering worker paths and control metadata', async () => {
    const file = path.join(workspace, 'file.txt');
    await writeFile(file, 'content');
    vi.spyOn(environment, 'execute').mockResolvedValueOnce({
      llmContent: 'remote result',
      returnDisplay: 'remote result',
      outputBudgetApplied: true,
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
      outputBudgetApplied: true,
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
