// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const state = vi.hoisted(() => ({
  status: undefined as unknown,
  entries: [] as unknown[],
  loading: false,
  error: undefined as Error | undefined,
  readAutoMemoryFile: vi.fn(),
  openAutoMemoryFolder: vi.fn(),
  settings: [] as unknown[],
  setValue: vi.fn(),
  features: [] as string[],
  localDaemon: false,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useAutoMemory: () => ({
      status: state.status,
      entries: state.entries,
      loading: state.loading,
      error: state.error,
      readAutoMemoryFile: state.readAutoMemoryFile,
      openAutoMemoryFolder: state.openAutoMemoryFolder,
    }),
    useSettings: () => ({
      settings: state.settings,
      setValue: state.setValue,
    }),
    useConnection: () => ({
      capabilities: { features: state.features },
    }),
  };
});

vi.mock('../../config/daemon', () => ({
  isLocalDaemon: () => state.localDaemon,
}));

const { AutoMemoryPanel } = await import('./AutoMemoryPanel');

const PROJECT_ENTRY = {
  kind: 'auto_memory_file',
  scope: 'project',
  path: '/workspace/.qwen/auto-memory/project/notes.md',
  title: 'Build notes',
  description: 'How the project builds',
  type: 'project',
  bytes: 512,
  modifiedAt: '2026-10-14T12:00:00.000Z',
};

const USER_ENTRY = {
  kind: 'auto_memory_file',
  scope: 'user',
  path: '/home/u/.qwen/auto-memory/preferences.md',
  title: 'Preferences',
  bytes: 512,
  modifiedAt: '2026-10-14T13:00:00.000Z',
};

function listing(
  entries: Array<typeof PROJECT_ENTRY> = [PROJECT_ENTRY, USER_ENTRY],
) {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    userDir: '/home/u/.qwen/auto-memory',
    projectDir: '/workspace/.qwen/auto-memory',
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    fileCount: entries.length,
  };
}

function settingsWith(autoMemory: boolean, autoDream: boolean) {
  return [
    {
      key: 'memory.enableManagedAutoMemory',
      type: 'boolean',
      label: 'Auto-memory',
      category: 'memory',
      requiresRestart: false,
      default: false,
      values: { effective: autoMemory },
    },
    {
      key: 'memory.enableManagedAutoDream',
      type: 'boolean',
      label: 'Auto-dream',
      category: 'memory',
      requiresRestart: false,
      default: false,
      values: { effective: autoDream },
    },
  ];
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(
  onMessage?: (message: string, type?: 'status' | 'error') => void,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <AutoMemoryPanel onMessage={onMessage} />
      </I18nProvider>,
    );
  });
  await flush();
}

function switches(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll('[role="switch"]'),
  ) as HTMLButtonElement[];
}

function entryButton(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(label),
  );
  if (!match) throw new Error(`entry button not found: ${label}`);
  return match;
}

function openFolderButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter(
    (item) => item.textContent === 'Open folder',
  );
}

beforeEach(() => {
  state.status = listing();
  state.entries = [PROJECT_ENTRY, USER_ENTRY];
  state.loading = false;
  state.error = undefined;
  state.settings = settingsWith(true, false);
  state.features = [];
  state.localDaemon = false;
  state.readAutoMemoryFile.mockReset();
  state.openAutoMemoryFolder.mockReset().mockResolvedValue(undefined);
  state.setValue.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AutoMemoryPanel', () => {
  it('lists entries grouped by scope with sizes', async () => {
    await mount();

    expect(container.textContent).toContain('Project memory');
    expect(container.textContent).toContain('User memory');
    expect(container.textContent).toContain('Build notes');
    expect(container.textContent).toContain('How the project builds');
    expect(container.textContent).toContain('/workspace/.qwen/auto-memory');
    // One 512-byte entry per scope.
    expect(container.textContent).toContain('1 · 512 B');
    expect(container.textContent).toContain('512 B');
  });

  it('shows the not-initialized hint when no directory exists yet', async () => {
    state.status = { ...listing([]), initialized: false };
    state.entries = [];

    await mount();

    expect(container.textContent).toContain(
      'No auto-memory directories have been created yet.',
    );
    expect(container.textContent).toContain('No auto-memory entries yet.');
  });

  it('reads the selected entry content through the auto-memory route', async () => {
    state.readAutoMemoryFile.mockResolvedValue({
      scope: 'project',
      path: PROJECT_ENTRY.path,
      bytes: 512,
      content: 'the note body\n',
      truncated: false,
    });

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();

    expect(state.readAutoMemoryFile).toHaveBeenCalledWith(PROJECT_ENTRY.path);
    expect(container.textContent).toContain('the note body');
  });

  it('flags truncated content', async () => {
    state.readAutoMemoryFile.mockResolvedValue({
      scope: 'project',
      path: PROJECT_ENTRY.path,
      bytes: 512,
      content: 'partial',
      truncated: true,
    });

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();

    expect(container.textContent).toContain('partial');
    expect(container.textContent).toContain(
      'Content is truncated (the file is larger than the read limit).',
    );
  });

  it('shows an unavailable notice when the daemon returns no content', async () => {
    state.readAutoMemoryFile.mockResolvedValue({
      scope: 'project',
      path: PROJECT_ENTRY.path,
      bytes: 512,
    });

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();

    expect(container.textContent).toContain(
      'Content is not available for this entry.',
    );
  });

  it('surfaces a read error for the selected entry', async () => {
    state.readAutoMemoryFile.mockRejectedValue(
      new Error('GET /workspace/auto-memory/file: 404 Not Found'),
    );

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();

    expect(container.textContent).toContain(
      'GET /workspace/auto-memory/file: 404 Not Found',
    );
  });

  it('shows a loading hint while the status is in flight', async () => {
    state.status = undefined;
    state.loading = true;

    await mount();

    expect(container.textContent).toContain('Loading memory...');
  });

  it('shows the load error when the status request fails', async () => {
    state.status = undefined;
    state.error = new Error('GET /workspace/auto-memory: 500 Internal');

    await mount();

    expect(container.textContent).toContain(
      'GET /workspace/auto-memory: 500 Internal',
    );
  });

  it('reflects the effective setting values on the toggles', async () => {
    await mount();

    const [autoMemorySwitch, autoDreamSwitch] = switches();
    expect(autoMemorySwitch.getAttribute('aria-checked')).toBe('true');
    expect(autoDreamSwitch.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toContain(
      'Capture memories automatically while working',
    );
    expect(container.textContent).toContain(
      'Consolidate memories in the background',
    );
  });

  it('writes a toggle change to the user scope', async () => {
    await mount();

    act(() => switches()[0].click());
    await flush();

    expect(state.setValue).toHaveBeenCalledWith(
      'user',
      'memory.enableManagedAutoMemory',
      false,
    );
  });

  it('reports a failed toggle as an error notice', async () => {
    state.setValue.mockRejectedValue(new Error('Set setting failed: 500'));
    const onMessage = vi.fn();

    await mount(onMessage);
    act(() => switches()[0].click());
    await flush();

    expect(container.textContent).toContain('Set setting failed: 500');
    expect(onMessage).toHaveBeenCalledWith('Set setting failed: 500', 'error');
  });

  it('hides the folder button unless the daemon is local with the feature', async () => {
    await mount();
    expect(openFolderButtons()).toHaveLength(0);

    state.localDaemon = true;
    act(() =>
      root.render(
        <I18nProvider language="en">
          <AutoMemoryPanel />
        </I18nProvider>,
      ),
    );
    await flush();
    expect(openFolderButtons()).toHaveLength(0);

    state.features = ['workspace_local_open'];
    act(() =>
      root.render(
        <I18nProvider language="en">
          <AutoMemoryPanel />
        </I18nProvider>,
      ),
    );
    await flush();
    expect(openFolderButtons()).toHaveLength(2);
  });

  it('opens the memory folder for a scope on the daemon host', async () => {
    state.localDaemon = true;
    state.features = ['workspace_local_open'];

    await mount();
    act(() => openFolderButtons()[0].click());
    await flush();

    expect(state.openAutoMemoryFolder).toHaveBeenCalledWith(
      'project',
      '/workspace',
    );
  });
});
