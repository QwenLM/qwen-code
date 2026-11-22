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
const scopedHandle = vi.hoisted(() => ({
  workspaceMemory: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceMemory: vi.fn(),
}));
const client = vi.hoisted(() => ({
  workspaceByCwd: vi.fn(() => scopedHandle),
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspace: () => ({ actions, client }),
  useDaemonWorkspaceActions: () => actions,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonMemory } = await import('./useDaemonMemory.js');

const GLOBAL_PATH = '/home/u/.qwen/QWEN.md';
const WORKSPACE_PATH = '/w/QWEN.md';

function captureMemoryHook(options?: { workspaceCwd?: string }) {
  let hook: ReturnType<typeof useDaemonMemory> | undefined;
  function Probe() {
    hook = useDaemonMemory(options);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return hook!;
}

function captureReadMemoryFile(options?: { workspaceCwd?: string }) {
  return captureMemoryHook(options).readMemoryFile;
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

  it('routes workspace-scoped reads and writes through workspaceByCwd while keeping global writes unscoped', async () => {
    client.workspaceByCwd.mockClear();
    actions.writeMemory.mockClear();
    scopedHandle.workspaceMemory.mockResolvedValue({
      v: 1,
      workspaceCwd: '/secondary',
      initialized: true,
      files: [
        {
          kind: 'memory_file',
          path: '/secondary/QWEN.md',
          scope: 'workspace',
          bytes: 5,
          content: 'hello',
        },
      ],
    });
    scopedHandle.writeWorkspaceMemory.mockResolvedValue({
      ok: true,
      filePath: '/secondary/QWEN.md',
      bytesWritten: 5,
      mode: 'replace',
    });
    actions.writeMemory.mockResolvedValue({
      ok: true,
      filePath: GLOBAL_PATH,
      bytesWritten: 6,
      mode: 'replace',
    });

    const hook = captureMemoryHook({ workspaceCwd: '/secondary' });
    await expect(hook.readMemoryFile('/secondary/QWEN.md')).resolves.toEqual({
      content: 'hello',
      truncated: false,
    });
    expect(client.workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(scopedHandle.workspaceMemory).toHaveBeenCalledWith({
      includeContent: true,
    });

    await hook.writeMemory({
      scope: 'workspace',
      mode: 'replace',
      content: 'hello',
    });
    expect(scopedHandle.writeWorkspaceMemory).toHaveBeenCalledWith({
      scope: 'workspace',
      mode: 'replace',
      content: 'hello',
    });
    expect(actions.writeMemory).not.toHaveBeenCalled();

    await hook.writeMemory({
      scope: 'global',
      mode: 'replace',
      content: 'global',
    });
    expect(actions.writeMemory).toHaveBeenCalledWith({
      scope: 'global',
      mode: 'replace',
      content: 'global',
    });
  });
});
