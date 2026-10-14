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
  loadAutoMemoryStatus: vi.fn(),
  readAutoMemoryFile: vi.fn(),
  openAutoMemoryFolder: vi.fn(),
}));

vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => actions,
}));

const { useDaemonAutoMemory } = await import('./useDaemonAutoMemory.js');

const PROJECT_ENTRY = {
  kind: 'auto_memory_file',
  scope: 'project',
  path: '/workspace/.qwen/auto-memory/project/notes.md',
  title: 'Build notes',
  bytes: 4,
  modifiedAt: '2026-10-14T12:00:00.000Z',
};

const USER_ENTRY = {
  kind: 'auto_memory_file',
  scope: 'user',
  path: '/home/u/.qwen/auto-memory/preferences.md',
  title: 'Preferences',
  bytes: 8,
  modifiedAt: '2026-10-14T13:00:00.000Z',
};

function listing(entries: Array<typeof PROJECT_ENTRY>) {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: entries.length > 0,
    userDir: '/home/u/.qwen/auto-memory',
    projectDir: '/workspace/.qwen/auto-memory',
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    fileCount: entries.length,
  };
}

function mountProbe() {
  let hook: ReturnType<typeof useDaemonAutoMemory> | undefined;
  function Probe() {
    hook = useDaemonAutoMemory();
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  return {
    get value() {
      return hook!;
    },
    unmount: () => act(() => root.unmount()),
  };
}

describe('useDaemonAutoMemory', () => {
  it('exposes an empty listing before the status has loaded', () => {
    const probe = mountProbe();
    expect(probe.value.status).toBeUndefined();
    expect(probe.value.entries).toEqual([]);
    expect(actions.loadAutoMemoryStatus).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('derives status and entries from the loaded listing', async () => {
    actions.loadAutoMemoryStatus.mockResolvedValue(
      listing([PROJECT_ENTRY, USER_ENTRY]),
    );

    const probe = mountProbe();
    await act(async () => {
      await probe.value.reload();
    });

    expect(actions.loadAutoMemoryStatus).toHaveBeenCalledTimes(1);
    expect(probe.value.status).toEqual(listing([PROJECT_ENTRY, USER_ENTRY]));
    expect(probe.value.entries).toEqual([PROJECT_ENTRY, USER_ENTRY]);
    probe.unmount();
  });

  it('passes reads and folder opens straight through to the actions', async () => {
    actions.readAutoMemoryFile.mockResolvedValue({
      scope: 'project',
      path: PROJECT_ENTRY.path,
      bytes: 4,
      content: 'note body\n',
      truncated: false,
    });
    actions.openAutoMemoryFolder.mockResolvedValue(undefined);

    const probe = mountProbe();
    await expect(
      probe.value.readAutoMemoryFile(PROJECT_ENTRY.path),
    ).resolves.toEqual({
      scope: 'project',
      path: PROJECT_ENTRY.path,
      bytes: 4,
      content: 'note body\n',
      truncated: false,
    });
    expect(actions.readAutoMemoryFile).toHaveBeenCalledWith(PROJECT_ENTRY.path);
    await expect(
      probe.value.openAutoMemoryFolder('project', '/workspace'),
    ).resolves.toBeUndefined();
    expect(actions.openAutoMemoryFolder).toHaveBeenCalledWith(
      'project',
      '/workspace',
    );
    probe.unmount();
  });
});
