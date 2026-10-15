// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const actions = vi.hoisted(() => ({
  loadMemoryStatus: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeMemory: vi.fn(),
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => actions,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => undefined,
}));

const { useDaemonMemory } = await import('./useDaemonMemory.js');

const GLOBAL_PATH = '/home/u/.qwen/QWEN.md';

function captureReadMemoryFile() {
  let read: ReturnType<typeof useDaemonMemory>['readMemoryFile'] | undefined;
  function Probe() {
    read = useDaemonMemory().readMemoryFile;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return read!;
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
});
