/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, realpath, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, deriveConfig } from '../config/config.js';
import { NotebookEditTool } from './notebook-edit.js';
import { ReadFileTool } from './read-file.js';
import { ToolRegistry } from './tool-registry.js';
import {
  createBuiltinManagedToolRuntime,
  type ManagedToolRuntime,
} from './managed-tool-runtime.js';
import { RuntimeBackedTool } from './runtime-backed-tool.js';
import { getNotebookEditToolDefinition } from './builtin-tool-definitions.js';
import {
  parseManagedToolInvocationReference,
  type ManagedToolPrepareResponse,
} from './managed-tool-protocol.js';
import { ToolConfirmationOutcome } from './tools.js';

function reference(prepared: ManagedToolPrepareResponse) {
  const {
    params: _params,
    description: _description,
    locations: _locations,
    defaultPermission: _permission,
    requiresUserInteraction: _interaction,
    toolUseId: _toolUseId,
    ...ref
  } = prepared;
  return parseManagedToolInvocationReference(ref);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('managed native notebook editing', () => {
  let root: string;
  let config: Config;
  let registry: ToolRegistry;
  let runtime: ManagedToolRuntime;
  let notebookPath: string;
  let initial: string;
  let call: {
    sessionId: string;
    promptId: string;
    callId: string;
    capabilityDigest: string;
    policyRevision: string;
  };
  const signal = new AbortController().signal;
  const params = () => ({
    notebook_path: notebookPath,
    cell_id: 'a',
    new_source: 'proposal = 2\n',
  });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'managed-notebook-')));
    vi.stubEnv('QWEN_HOME', join(root, 'home'));
    vi.stubEnv('QWEN_RUNTIME_DIR', join(root, 'runtime'));
    config = new Config({
      targetDir: root,
      cwd: root,
      model: 'test',
      debugMode: false,
      telemetry: { enabled: false },
      usageStatisticsEnabled: false,
      disableAllHooks: true,
    });
    registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ReadFileTool(config));
    registry.registerTool(new NotebookEditTool(config));
    notebookPath = join(root, 'analysis.ipynb');
    initial = JSON.stringify(
      {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: 'a',
            cell_type: 'code',
            metadata: {},
            source: ['old = 1\n'],
            outputs: [],
            execution_count: null,
          },
          {
            id: 'b',
            cell_type: 'markdown',
            metadata: {},
            source: ['old note'],
          },
        ],
      },
      null,
      1,
    );
    await writeFile(notebookPath, initial);
    runtime = await createBuiltinManagedToolRuntime(config);
    const manifest = runtime.manifest();
    call = {
      sessionId: config.getSessionId(),
      promptId: 'turn',
      callId: 'edit',
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: manifest.policyRevision,
    };
    await runtime.beginTurn(call);
  });
  afterEach(async () => {
    await runtime?.dispose();
    await registry?.stop();
    await config?.shutdown({ shutdownTelemetry: false });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  async function read() {
    const ref = reference(
      await runtime.prepare({ ...call, callId: 'read' }, ReadFileTool.Name, {
        file_path: notebookPath,
      }),
    );
    await runtime.preflight(ref);
    expect((await runtime.execute(ref)).executionStatus).toBe('success');
  }
  async function prepared() {
    await read();
    return runtime.prepare(call, NotebookEditTool.Name, params());
  }
  async function execute(value: ManagedToolPrepareResponse) {
    const ref = reference(value);
    await runtime.confirmation(ref);
    await runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce);
    await runtime.preflight(ref);
    return runtime.execute(ref);
  }

  it('reuses complete reads in the native Runtime and preserves sibling cells', async () => {
    const result = await execute(await prepared());
    expect(result.executionStatus).toBe('success');
    const notebook = JSON.parse(await readFile(notebookPath, 'utf8'));
    expect(notebook.cells[0].source).toEqual(['proposal = 2\n']);
    expect(notebook.cells[1].source).toEqual(['old note']);
  });

  it.each(['read', 'backup', 'written'] as const)(
    'drains cancellation during %s and reports the actual write outcome',
    async (phase) => {
      const ref = reference(await prepared());
      await runtime.confirmation(ref);
      await runtime.confirm(ref, ToolConfirmationOutcome.ProceedOnce);
      await runtime.preflight(ref);
      const held = deferred();
      const resume = deferred();
      const pause = async () => {
        held.resolve();
        await resume.promise;
      };
      const filesystem = config.getFileSystemService();
      const history = config.getFileHistoryService();
      if (phase === 'read') {
        const original = filesystem.readTextFile.bind(filesystem);
        vi.spyOn(filesystem, 'readTextFile').mockImplementation(
          async (input) => {
            const result = await original(input);
            await pause();
            return result;
          },
        );
      } else if (phase === 'backup') {
        const original = history.trackEdit.bind(history);
        vi.spyOn(history, 'trackEdit').mockImplementation(async (file) => {
          await original(file);
          await pause();
        });
      } else {
        const original = filesystem.writeTextFile.bind(filesystem);
        vi.spyOn(filesystem, 'writeTextFile').mockImplementation(
          async (input) => {
            const result = await original(input);
            await pause();
            return result;
          },
        );
      }
      const executing = runtime.execute(ref);
      let settled = false;
      void executing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      let disposing: Promise<void> | undefined;
      let disposed = false;
      try {
        await held.promise;
        expect(runtime.cancel(ref).state).toBe('cancel_requested');
        disposing = runtime.dispose().then(() => {
          disposed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(disposed).toBe(false);
        expect((await readFile(notebookPath, 'utf8')) !== initial).toBe(
          phase === 'written',
        );
        resume.resolve();
        const result = await executing;
        await disposing;
        expect(result.executionStatus).toBe(
          phase === 'written' ? 'success' : 'cancelled',
        );
        expect((await readFile(notebookPath, 'utf8')) !== initial).toBe(
          phase === 'written',
        );
        if (phase === 'written') {
          expect(
            JSON.parse(await readFile(notebookPath, 'utf8')).cells[0].source,
          ).toEqual(['proposal = 2\n']);
        }
      } finally {
        resume.resolve();
        await executing;
        await disposing;
      }
    },
  );

  it('rejects an already cancelled native edit before filesystem operations', async () => {
    await read();
    const invocation = new NotebookEditTool(config).build(params());
    const readText = vi.spyOn(config.getFileSystemService(), 'readTextFile');
    const track = vi.spyOn(config.getFileHistoryService(), 'trackEdit');
    const writeText = vi.spyOn(config.getFileSystemService(), 'writeTextFile');
    const controller = new AbortController();
    controller.abort(new Error('cancel before execution'));
    await expect(invocation.execute(controller.signal)).rejects.toThrow(
      'cancel before execution',
    );
    expect(readText).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(await readFile(notebookPath, 'utf8')).toBe(initial);
  });

  it('carries full notebook modifications through the proxy, preserves native metadata and retries', async () => {
    await read();
    const proxy = new RuntimeBackedTool({
      descriptor: getNotebookEditToolDefinition(),
      sessionId: call.sessionId,
      getClient: async () => ({
        manifest: async () => runtime.manifest(),
        beginTurn: (...args) => runtime.beginTurn(...args),
        prepare: (...args) => runtime.prepare(...args),
        confirmation: (...args) => runtime.confirmation(...args),
        confirm: (...args) => runtime.confirm(...args),
        preflight: (...args) => runtime.preflight(...args),
        execute: (...args) => runtime.execute(...args),
        status: async (...args) => runtime.status(...args),
        cancel: async (...args) => runtime.cancel(...args),
      }),
      projectClassifierInput: () => '',
    });
    const first = proxy.build(params());
    const context = { callId: call.callId, promptId: call.promptId };
    await first.prepare(signal, context);
    expect(() => first.contentModification(initial)).toThrow(
      'editable confirmation',
    );
    await first.getConfirmationDetails(signal);
    const proposed = JSON.parse(initial);
    proposed.cells[0].source = ['user = 3\n'];
    proposed.cells[1].source = ['user changed the other cell'];
    const newContent = JSON.stringify(proposed, null, 1);
    const modification = first.contentModification(newContent);
    await first.cancelAndDrain();
    const second = proxy.build(first.params);
    const build = vi.spyOn(NotebookEditTool.prototype, 'build');
    await second.prepare(signal, context, modification);
    const current = await runtime.prepare(
      call,
      NotebookEditTool.Name,
      params(),
      modification,
    );
    expect(build).toHaveBeenCalledOnce();
    expect(current.invocationId).not.toBe(modification.source.invocationId);
    expect(current.argsDigest).toBe(modification.source.argsDigest);
    expect(current.params).toEqual(params());
    const details = await second.getConfirmationDetails(signal);
    expect(details).toMatchObject({
      type: 'edit',
      originalContent: initial,
      newContent,
    });
    expect(await readFile(notebookPath, 'utf8')).toBe(initial);
    expect(() => runtime.execute(modification.source)).toThrow();
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    await second.preflight();
    second.authorize();
    const result = await second.execute(signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('modified by the user');
    expect(await readFile(notebookPath, 'utf8')).toBe(newContent);
  });

  it.each([
    'uncancelled',
    'missing confirmation',
    'wrong reference',
    'changed params',
    'executed',
  ])('rejects a modification with %s before writing', async (scenario) => {
    const value = await prepared();
    const source = reference(value);
    if (scenario !== 'missing confirmation') await runtime.confirmation(source);
    if (scenario === 'executed') await execute(value);
    if (scenario !== 'uncancelled') await runtime.cancel(source);
    const before = await readFile(notebookPath, 'utf8');
    await expect(
      runtime.prepare(
        call,
        NotebookEditTool.Name,
        scenario === 'changed params'
          ? { ...params(), new_source: 'changed' }
          : params(),
        {
          source:
            scenario === 'wrong reference'
              ? { ...source, callId: 'wrong' }
              : source,
          newContent: initial,
        },
      ),
    ).rejects.toThrow();
    expect(await readFile(notebookPath, 'utf8')).toBe(before);
  });

  it.each(['', 'invalid JSON'])(
    'passes invalid modified content to native validation: %j',
    async (newContent) => {
      const source = reference(await prepared());
      await runtime.confirmation(source);
      await runtime.cancel(source);
      const value = await runtime.prepare(
        call,
        NotebookEditTool.Name,
        params(),
        { source, newContent },
      );
      await expect(runtime.confirmation(reference(value))).rejects.toThrow();
      expect(await readFile(notebookPath, 'utf8')).toBe(initial);
    },
  );

  it('uses the bound child cache and does not borrow a parent notebook read', async () => {
    await read();
    await runtime.dispose();
    const child = deriveConfig(config);
    runtime = await createBuiltinManagedToolRuntime(config, undefined, child);
    const manifest = runtime.manifest();
    call = {
      ...call,
      sessionId: child.getSessionId(),
      capabilityDigest: manifest.capabilityDigest,
      policyRevision: manifest.policyRevision,
    };
    await runtime.beginTurn(call);
    const value = await runtime.prepare(call, NotebookEditTool.Name, params());
    await expect(runtime.confirmation(reference(value))).rejects.toThrow(
      /read/i,
    );
    expect(await readFile(notebookPath, 'utf8')).toBe(initial);
  });
});
