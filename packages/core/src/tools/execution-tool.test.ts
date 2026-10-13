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
import { ToolConfirmationOutcome, type AnyDeclarativeTool } from './tools.js';

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

  const wrap = (tool: AnyDeclarativeTool = new ReadFileTool(config)) =>
    wrapExecutionTool(tool, environment, config);

  const run = (facade: AnyDeclarativeTool, file: string) =>
    facade.build({ file_path: file }).execute(signal);

  const writeWorkspaceFile = async (name: string, content: string) => {
    const file = path.join(workspace, name);
    await writeFile(file, content);
    return file;
  };

  /** Stays pending until `signal` aborts (later), then rejects with its reason. */
  const pendingUntilAbort = (
    signal: AbortSignal,
    onReject?: (reject: (error: Error) => void) => void,
  ) =>
    new Promise<never>((_resolve, reject) => {
      onReject?.(reject);
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });

  it('runs the parameters a hook or plan mode changed after preparation', async () => {
    const original = await writeWorkspaceFile('original.txt', 'original\n');
    const updated = await writeWorkspaceFile('updated.txt', 'updated\n');
    const prepare = vi.spyOn(environment, 'prepare');
    const release = vi.spyOn(environment, 'release');
    const invocation = wrap().build({ file_path: original });
    expect(await invocation.getDefaultPermission(signal)).toBe('allow');
    const [[first]] = prepare.mock.calls;

    // As Session applies a permission hook's updated input.
    invocation.params = { file_path: updated };
    const result = await invocation.execute(signal);

    expect(result.llmContent).toContain('updated');
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]![0]).toMatchObject({
      params: { file_path: updated },
    });
    expect(prepare.mock.calls[1]![0].id).not.toBe(first.id);
    expect(release).toHaveBeenCalledWith(first.id, expect.any(AbortSignal));
  });

  it('confirms the parameters that changed after preparation', async () => {
    const original = await writeWorkspaceFile('original.txt', 'original\n');
    const updated = await writeWorkspaceFile('updated.txt', 'updated\n');
    const prepare = vi.spyOn(environment, 'prepare');
    const invocation = wrap().build({ file_path: original });
    await invocation.getDefaultPermission(signal);
    // As plan mode adds a directory before it asks.
    invocation.params = { file_path: updated };
    await invocation.getConfirmationDetails(signal);
    expect(invocation.params).toMatchObject({ file_path: updated });
    const result = await invocation.execute(signal);
    expect(result.llmContent).toContain('updated');
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("prepares with the scheduler's call id the invocation carries", async () => {
    const file = await writeWorkspaceFile('call-id.txt', 'content\n');
    const prepare = vi.spyOn(environment, 'prepare');
    const invocation = wrap().build({ file_path: file }) as ReturnType<
      ReturnType<typeof wrap>['build']
    > & { setCallId(id: string): void };
    invocation.setCallId('model-call-1');
    await invocation.execute(signal);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toMatchObject({
      callId: 'model-call-1',
    });
    // The environment-facing id stays the invocation's own.
    expect(prepare.mock.calls[0]![0].id).not.toBe('model-call-1');
  });

  it('prepares once when the parameters did not change', async () => {
    const file = await writeWorkspaceFile('same.txt', 'same\n');
    const prepare = vi.spyOn(environment, 'prepare');
    const invocation = wrap().build({ file_path: file });
    await invocation.getDefaultPermission(signal);
    // The same parameters in another key order.
    invocation.params = Object.fromEntries(
      Object.entries(invocation.params).reverse(),
    );
    expect(Object.keys(invocation.params)[0]).not.toBe('file_path');
    await invocation.execute(signal);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('prepares once for a call whose parameters never change', async () => {
    const file = await writeWorkspaceFile('same.txt', 'same\n');
    const prepare = vi.spyOn(environment, 'prepare');
    const invocation = wrap().build({ file_path: file });
    await invocation.getDefaultPermission(signal);
    await invocation.execute(signal);
    expect(prepare).toHaveBeenCalledOnce();
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
      const facade = wrap(original);
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
    const file = await writeWorkspaceFile('file.txt', 'before\n');
    const original = new ReadFileTool(config);
    const hostBuild = vi.spyOn(original, 'build').mockImplementation(() => {
      throw new Error('host build must not run');
    });
    const hostFs = vi
      .spyOn(config, 'getFileSystemService')
      .mockImplementation(() => {
        throw new Error('host fs must not run');
      });
    const facade = wrap(original);
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
      wrap(edit).toAutoClassifierInput({
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
    const file = await writeWorkspaceFile('file.txt', 'read me\n');
    const facade = wrap();
    await run(facade, file);
    expect((await run(facade, file)).llmContent).toContain(
      'unchanged since last read',
    );
    config.getFileReadCache().clear();
    expect((await run(facade, file)).llmContent).toContain('read me');
  });

  it('retries failed invalidation before preparing another invocation', async () => {
    const file = await writeWorkspaceFile('file.txt', 'read me');
    const facade = wrap();
    await run(facade, file);
    config.getFileReadCache().clear();
    const invalidate = vi
      .spyOn(environment, 'invalidateReadCache')
      .mockRejectedValueOnce(new Error('failed invalidation'));
    const prepare = vi.spyOn(environment, 'prepare');
    await expect(run(facade, file)).rejects.toThrow('failed invalidation');
    expect(prepare).not.toHaveBeenCalled();
    expect((await run(facade, file)).llmContent).toContain('read me');
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
    vi.spyOn(environment, phase).mockImplementation((_request, signal) => {
      pendingSignal = signal;
      return pendingUntilAbort(signal);
    });
    const release = vi.spyOn(environment, 'release');
    const invocation = wrap().build({
      file_path: path.join(workspace, 'file.txt'),
    });
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
    const invocation = wrap().build({
      file_path: path.join(workspace, 'file.txt'),
    });
    expect(await invocation.getDefaultPermission()).toBe('deny');
    await invocation.release?.();
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds release when a cancelled permission request also loses its cleanup reply', async () => {
    const file = await writeWorkspaceFile('file.txt', 'content');
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal);
    const timeoutError = new Error('release timed out');
    let permissionSignal!: AbortSignal;
    let releaseSignal!: AbortSignal;
    let rejectRelease: ((error: Error) => void) | undefined;
    const permission = vi
      .spyOn(environment, 'permission')
      .mockImplementation((_id, signal) => {
        permissionSignal = signal;
        return pendingUntilAbort(signal);
      });
    const release = vi
      .spyOn(environment, 'release')
      .mockImplementation((_id, signal) => {
        releaseSignal = signal;
        return pendingUntilAbort(signal, (reject) => (rejectRelease = reject));
      });
    const invocation = wrap().build({ file_path: file });
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
    const facade = wrap(new WriteFileTool(config));
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

  it('drops an editor modification once the parameters change again', async () => {
    const file = path.join(workspace, 'modified.txt');
    const facade = wrap(new WriteFileTool(config));
    if (!isModifiableDeclarativeTool(facade)) throw new Error('not modifiable');
    const proposed = { file_path: file, content: 'proposed' };
    const first = facade.build(proposed) as ReturnType<typeof facade.build> & {
      setCallId(id: string): void;
    };
    first.setCallId('modify-call');
    const edited = facade
      .getModifyContext(signal, 'modify-call')
      .createUpdatedParams('', 'from editor', proposed);
    const updated = facade.build(edited) as typeof first;
    updated.setCallId('modify-call');
    await updated.getDefaultPermission(signal);
    // As a permission hook replaces the input after that.
    updated.params = { file_path: file, content: 'from hook' };
    expect((await updated.execute(signal)).error).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('from hook');
  });

  it('preserves output sizing while filtering worker paths and control metadata', async () => {
    const file = await writeWorkspaceFile('file.txt', 'content');
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
    const facade = wrap();
    expect(await run(facade, file)).toEqual({
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
      expect((await run(wrap(), file)).error).toBeUndefined();
      const facade = wrap(new NotebookEditTool(config));
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
