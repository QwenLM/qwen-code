// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const actions = vi.hoisted(() => ({
  loadMemoryStatus: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeMemory: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  client: { workspaceByCwd: vi.fn() },
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => workspace,
  useDaemonWorkspaceActions: () => actions,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonMemory } = await import('./useDaemonMemory.js');

const GLOBAL_PATH = '/home/u/.qwen/QWEN.md';
const WORKSPACE_PATH = '/w/QWEN.md';

function captureMemory(options: Parameters<typeof useDaemonMemory>[0] = {}) {
  let memory: ReturnType<typeof useDaemonMemory> | undefined;
  function Probe() {
    memory = useDaemonMemory(options);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return memory!;
}

function captureReadMemoryFile() {
  return captureMemory().readMemoryFile;
}

function statusWith(file: Record<string, unknown>) {
  return {
    v: 1,
    workspaceCwd: '/w',
    initialized: true,
    files: [
      { kind: 'memory_file', path: GLOBAL_PATH, scope: 'global', ...file },
    ],
  };
}

describe('useDaemonMemory.readMemoryFile', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads through the memory route instead of the sandboxed file API', async () => {
    actions.loadMemoryStatus.mockResolvedValue(
      statusWith({ bytes: 4, content: 'mem\n' }),
    );

    await expect(captureReadMemoryFile()(GLOBAL_PATH)).resolves.toEqual({
      content: 'mem\n',
      truncated: false,
    });
    expect(actions.loadMemoryStatus).toHaveBeenCalledWith({
      includeContent: true,
    });
    expect(actions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it.each([
    { path: GLOBAL_PATH, scope: 'global' },
    { path: WORKSPACE_PATH, scope: 'workspace' },
  ])(
    'keeps explicitly withheld $scope content read-only without using the file API',
    async ({ path, scope }) => {
      actions.loadMemoryStatus.mockResolvedValue(
        statusWith({ path, scope, bytes: 4, truncated: true }),
      );
      actions.readWorkspaceFile.mockResolvedValue({
        content: 'decoded without its BOM',
        truncated: false,
      });

      await expect(captureReadMemoryFile()(path)).resolves.toEqual({
        content: '',
        truncated: true,
      });
      expect(actions.readWorkspaceFile).not.toHaveBeenCalled();
    },
  );

  it('preserves the read-only marker for a partial content prefix', async () => {
    actions.loadMemoryStatus.mockResolvedValue(
      statusWith({ bytes: 8, content: 'part', truncated: true }),
    );

    await expect(captureReadMemoryFile()(GLOBAL_PATH)).resolves.toEqual({
      content: 'part',
      truncated: true,
    });
    expect(actions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('accepts complete empty content without falling back', async () => {
    actions.loadMemoryStatus.mockResolvedValue(
      statusWith({ bytes: 0, content: '', truncated: false }),
    );

    await expect(captureReadMemoryFile()(GLOBAL_PATH)).resolves.toEqual({
      content: '',
      truncated: false,
    });
    expect(actions.readWorkspaceFile).not.toHaveBeenCalled();
  });

  it('falls back to the file API when the daemon returns no content', async () => {
    actions.loadMemoryStatus.mockResolvedValue(statusWith({ bytes: 4 }));
    actions.readWorkspaceFile.mockRejectedValue(
      new Error('path escapes workspace'),
    );

    await expect(captureReadMemoryFile()(GLOBAL_PATH)).rejects.toThrow(
      'path escapes workspace',
    );
    expect(actions.readWorkspaceFile).toHaveBeenCalledWith(GLOBAL_PATH);
  });

  it('preserves workspace fallback for daemons without content support', async () => {
    actions.loadMemoryStatus.mockResolvedValue(
      statusWith({ path: WORKSPACE_PATH, scope: 'workspace', bytes: 4 }),
    );
    actions.readWorkspaceFile.mockResolvedValue({
      content: 'mem\n',
      truncated: false,
    });

    await expect(captureReadMemoryFile()(WORKSPACE_PATH)).resolves.toEqual({
      content: 'mem\n',
      truncated: false,
    });
    expect(actions.readWorkspaceFile).toHaveBeenCalledWith(WORKSPACE_PATH);
  });

  it('routes workspace memory reads and writes through the scoped client', async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValue({ content: 'b\n', truncated: false });
    const writeWorkspaceMemory = vi.fn().mockResolvedValue({ ok: true });
    workspace.client.workspaceByCwd.mockReturnValue({
      readWorkspaceFile,
      writeWorkspaceMemory,
    });

    const memory = captureMemory({ workspaceCwd: '/w/b' });

    await expect(memory.readMemoryFile(WORKSPACE_PATH)).resolves.toEqual({
      content: 'b\n',
      truncated: false,
    });
    expect(workspace.client.workspaceByCwd).toHaveBeenCalledWith('/w/b');
    expect(readWorkspaceFile).toHaveBeenCalledWith(WORKSPACE_PATH);
    expect(actions.loadMemoryStatus).not.toHaveBeenCalled();

    await memory.writeMemory({
      scope: 'workspace',
      mode: 'replace',
      content: 'updated\n',
    });

    expect(writeWorkspaceMemory).toHaveBeenCalledWith({
      scope: 'workspace',
      mode: 'replace',
      content: 'updated\n',
    });
    expect(actions.writeMemory).not.toHaveBeenCalled();
  });
});
