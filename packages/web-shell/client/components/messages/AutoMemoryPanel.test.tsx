// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonAutoMemoryFile,
  DaemonSettingDescriptor,
  DaemonWorkspaceAutoMemoryStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Knobs typed with the published wire types, so a fixture shape the
// daemon never sends does not typecheck. `entries` is not a knob: the real
// hook derives it from the status (`status?.entries ?? []`).
const state = vi.hoisted(() => ({
  status: undefined as DaemonWorkspaceAutoMemoryStatus | undefined,
  loading: false,
  error: undefined as Error | undefined,
  readAutoMemoryFile: vi.fn(),
  openAutoMemoryFolder: vi.fn(),
  settings: [] as DaemonSettingDescriptor[],
  settingsError: undefined as Error | undefined,
  setValue: vi.fn(),
  reload: vi.fn(),
  features: [] as string[],
  localDaemon: false,
  autoMemoryOptions: undefined as unknown,
  settingsOptions: undefined as unknown,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useAutoMemory: (options?: unknown) => {
      state.autoMemoryOptions = options;
      return {
        status: state.status,
        entries: state.status?.entries ?? [],
        loading: state.loading,
        error: state.error,
        readAutoMemoryFile: state.readAutoMemoryFile,
        openAutoMemoryFolder: state.openAutoMemoryFolder,
      };
    },
    useSettings: (options?: unknown) => {
      state.settingsOptions = options;
      return {
        settings: state.settings,
        error: state.settingsError,
        setValue: state.setValue,
        reload: state.reload,
      };
    },
    useConnection: () => ({
      capabilities: { features: state.features },
    }),
  };
});

vi.mock('../../config/daemon', () => ({
  isLocalDaemon: () => state.localDaemon,
}));

const { AutoMemoryPanel } = await import('./AutoMemoryPanel');

const PROJECT_DIR = '/workspace/.qwen/memory';
const USER_DIR = '/home/u/.qwen/memories';

const PROJECT_ENTRY: DaemonAutoMemoryFile = {
  kind: 'auto_memory_file',
  scope: 'project',
  path: `${PROJECT_DIR}/notes.md`,
  title: 'Build notes',
  description: 'How the project builds',
  type: 'project',
  bytes: 512,
  modifiedAt: '2026-10-14T12:00:00.000Z',
};

const USER_ENTRY: DaemonAutoMemoryFile = {
  kind: 'auto_memory_file',
  scope: 'user',
  path: `${USER_DIR}/preferences.md`,
  title: 'Preferences',
  bytes: 512,
  modifiedAt: '2026-10-14T13:00:00.000Z',
};

function listing(
  entries: DaemonAutoMemoryFile[] = [PROJECT_ENTRY, USER_ENTRY],
  overrides: Partial<DaemonWorkspaceAutoMemoryStatus> = {},
): DaemonWorkspaceAutoMemoryStatus {
  return {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    userDir: USER_DIR,
    userDirExists: true,
    projectDir: PROJECT_DIR,
    projectDirs: [PROJECT_DIR],
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    fileCount: entries.length,
    ...overrides,
  };
}

/**
 * Descriptors shaped like the served ones: both keys default to true and
 * require a restart (settingsSchema.ts); a value that differs from the
 * default is defined at user scope, as the daemon would report it.
 */
function descriptor(
  key: string,
  label: string,
  values: DaemonSettingDescriptor['values'],
): DaemonSettingDescriptor {
  return {
    key,
    type: 'boolean',
    label,
    category: 'Memory',
    requiresRestart: true,
    default: true,
    values,
  };
}

function userValue(value: boolean): DaemonSettingDescriptor['values'] {
  return value ? { effective: true } : { effective: false, user: false };
}

function settingsWith(
  autoMemory: boolean,
  autoDream: boolean,
): DaemonSettingDescriptor[] {
  return [
    descriptor(
      'memory.enableManagedAutoMemory',
      'Auto-memory',
      userValue(autoMemory),
    ),
    descriptor(
      'memory.enableManagedAutoDream',
      'Auto-dream',
      userValue(autoDream),
    ),
  ];
}

function rerender() {
  act(() =>
    root.render(
      <I18nProvider language="en">
        <AutoMemoryPanel />
      </I18nProvider>,
    ),
  );
}

function liveRegions(): Element[] {
  return Array.from(container.querySelectorAll('[aria-live="polite"]'));
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

function switchByLabel(label: string): HTMLButtonElement {
  const match = switches().find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`switch not found: ${label}`);
  return match;
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
  state.loading = false;
  state.error = undefined;
  state.settings = settingsWith(true, false);
  state.settingsError = undefined;
  state.features = [];
  state.localDaemon = false;
  state.autoMemoryOptions = undefined;
  state.settingsOptions = undefined;
  state.readAutoMemoryFile.mockReset();
  state.openAutoMemoryFolder.mockReset().mockResolvedValue(undefined);
  state.setValue.mockReset().mockResolvedValue({
    key: 'memory.enableManagedAutoMemory',
    scope: 'user',
    value: false,
    requiresRestart: false,
  });
  state.reload.mockReset().mockResolvedValue(undefined);
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
    expect(container.textContent).toContain(PROJECT_DIR);
    expect(container.textContent).toContain(USER_DIR);
    // One 512-byte entry per scope.
    expect(container.textContent).toContain('1 · 512 B');
    expect(container.textContent).toContain('512 B');
  });

  // The hooks are wired with autoLoad: without it the listing is never
  // requested (useDaemonResource defaults autoLoad=false) and the panel
  // renders only the two toggles. The mock captures the argument.
  it('loads the listing and the settings automatically', async () => {
    await mount();

    expect(state.autoMemoryOptions).toEqual({ autoLoad: true });
    expect(state.settingsOptions).toEqual({ autoLoad: true });
  });

  it('renders each row size distinct from the scope header total', async () => {
    // Two project entries with distinct sizes: the project header shows the
    // SUM (2.0 KB), a different string from either row size (512 B, 1.5 KB),
    // so a deleted per-row size would not be masked by the header total.
    state.status = listing([
      PROJECT_ENTRY,
      {
        ...PROJECT_ENTRY,
        path: `${PROJECT_DIR}/extra.md`,
        title: 'Extra notes',
        bytes: 1536,
      },
      USER_ENTRY,
    ]);

    await mount();

    expect(container.textContent).toContain('2 · 2.0 KB');
    expect(container.textContent).toContain('512 B');
    expect(container.textContent).toContain('1.5 KB');
  });

  it('shows the not-initialized hint when no directory exists yet', async () => {
    state.status = listing([], {
      initialized: false,
      userDirExists: false,
      projectDirs: [],
    });

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

  it('does not paint a late first read under a newer selection', async () => {
    // A second selection while the first read is still in flight: the
    // loadSeq guard must drop the late first response, not paint its body
    // under the second entry's path header.
    let resolveFirst: (value: { content: string }) => void = () => {};
    state.readAutoMemoryFile.mockImplementation((p: string) =>
      p === PROJECT_ENTRY.path
        ? new Promise<{ content: string }>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({
            scope: 'user',
            path: USER_ENTRY.path,
            bytes: USER_ENTRY.bytes,
            content: 'prefs body\n',
          }),
    );

    await mount();
    act(() => entryButton('Build notes').click());
    // Select the user entry while the first read is still in flight.
    act(() => entryButton('Preferences').click());
    await flush();

    // The late first read must not overwrite the newer selection.
    resolveFirst({ content: 'stale A body\n' });
    await flush();

    expect(container.textContent).toContain(USER_ENTRY.path);
    expect(container.textContent).toContain('prefs body');
    expect(container.textContent).not.toContain('stale A body');
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
    // No status means no entries: nothing is listed while loading.
    expect(container.textContent).not.toContain('Build notes');
    expect(container.textContent).not.toContain('Preferences');
  });

  it('shows the load error when the status request fails', async () => {
    state.status = undefined;
    state.error = new Error('GET /workspace/auto-memory: 500 Internal');

    await mount();

    expect(container.textContent).toContain(
      'GET /workspace/auto-memory: 500 Internal',
    );
    expect(container.textContent).not.toContain('Build notes');
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

    act(() => switchByLabel('Auto-memory').click());
    await flush();

    expect(state.setValue).toHaveBeenCalledWith(
      'user',
      'memory.enableManagedAutoMemory',
      false,
    );
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it('writes a toggle change to the workspace scope when a workspace value defines it', async () => {
    // A workspace-scope value wins in the merged effective value, so the
    // write must target the scope that currently defines the value.
    state.settings = [
      descriptor('memory.enableManagedAutoMemory', 'Auto-memory', {
        effective: false,
        workspace: false,
      }),
      descriptor('memory.enableManagedAutoDream', 'Auto-dream', {
        effective: true,
      }),
    ];

    await mount();

    act(() => switchByLabel('Auto-memory').click());
    await flush();

    expect(state.setValue).toHaveBeenCalledWith(
      'workspace',
      'memory.enableManagedAutoMemory',
      true,
    );
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it('reports a failed toggle as an error notice', async () => {
    state.setValue.mockRejectedValue(new Error('Set setting failed: 500'));
    const onMessage = vi.fn();

    await mount(onMessage);
    act(() => switches()[0].click());
    await flush();

    expect(container.textContent).toContain('Set setting failed: 500');
    expect(onMessage).toHaveBeenCalledWith('Set setting failed: 500', 'error');
    const liveRegion = container.querySelector('[role="status"]');
    expect(liveRegion?.textContent).toContain('Set setting failed: 500');
  });

  it('tracks in-flight toggles per switch, not globally', async () => {
    let resolveFirst: (value: void) => void = () => {};
    let resolveSecond: (value: void) => void = () => {};
    state.setValue.mockImplementation((_scope: string, key: string) =>
      key === 'memory.enableManagedAutoMemory'
        ? new Promise<void>((resolve) => {
            resolveFirst = resolve;
          })
        : new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
    );

    await mount();
    const autoMemorySwitch = switchByLabel('Auto-memory');
    const autoDreamSwitch = switchByLabel('Auto-dream');

    act(() => autoMemorySwitch.click());
    await flush();
    expect(autoMemorySwitch.disabled).toBe(true);
    // The in-flight write must not disable the other switch.
    expect(autoDreamSwitch.disabled).toBe(false);

    act(() => autoDreamSwitch.click());
    await flush();
    expect(state.setValue).toHaveBeenCalledTimes(2);
    expect(autoMemorySwitch.disabled).toBe(true);
    expect(autoDreamSwitch.disabled).toBe(true);

    await act(async () => {
      resolveFirst(undefined);
      resolveSecond(undefined);
    });
    await flush();
    expect(autoMemorySwitch.disabled).toBe(false);
    expect(autoDreamSwitch.disabled).toBe(false);
  });

  it('disables a switch only when its own setting is missing from the descriptors', async () => {
    state.settings = [
      descriptor('memory.enableManagedAutoMemory', 'Auto-memory', {
        effective: true,
      }),
    ];

    await mount();

    expect(switchByLabel('Auto-memory').disabled).toBe(false);
    expect(switchByLabel('Auto-dream').disabled).toBe(true);
  });

  it('surfaces per-root scan errors from the status', async () => {
    // The cell shape the daemon emits (DaemonStatusCell).
    state.status = listing([USER_ENTRY], {
      projectDirs: [],
      errors: [
        {
          kind: 'auto_memory_file',
          status: 'error',
          errorKind: 'symlinked_root',
          error: 'refusing symlinked project memory root',
          hint: PROJECT_DIR,
        },
      ],
    });

    await mount();

    // The pathless message is attributed to its root through `hint`.
    const [region] = liveRegions();
    expect(region.textContent).toContain(
      `refusing symlinked project memory root (${PROJECT_DIR})`,
    );
  });

  it('hides the folder button unless the daemon is local with the feature', async () => {
    await mount();
    expect(openFolderButtons()).toHaveLength(0);

    // A local daemon without the feature tag.
    state.localDaemon = true;
    rerender();
    await flush();
    expect(openFolderButtons()).toHaveLength(0);

    // The feature tag on a non-local daemon is not an open affordance.
    state.features = ['workspace_local_open'];
    state.localDaemon = false;
    rerender();
    await flush();
    expect(openFolderButtons()).toHaveLength(0);

    state.localDaemon = true;
    rerender();
    await flush();
    expect(openFolderButtons()).toHaveLength(2);

    // No directory exists yet: no button offers a guaranteed 404.
    state.status = listing([], {
      initialized: false,
      userDirExists: false,
      projectDirs: [],
    });
    rerender();
    await flush();
    expect(openFolderButtons()).toHaveLength(0);

    // Only the user root exists: only its button renders.
    state.status = listing([USER_ENTRY], { projectDirs: [] });
    rerender();
    await flush();
    expect(openFolderButtons()).toHaveLength(1);
    act(() => openFolderButtons()[0].click());
    await flush();
    expect(state.openAutoMemoryFolder).toHaveBeenLastCalledWith(
      'user',
      '/workspace',
      undefined,
    );
  });

  it('opens each walked project root and the user root with their own arguments', async () => {
    state.localDaemon = true;
    state.features = ['workspace_local_open'];
    const repoLocal = '/workspace/.qwen/memory';
    const configured = '/home/u/.qwen/projects/-workspace/memory';
    state.status = listing([PROJECT_ENTRY, USER_ENTRY], {
      projectDir: configured,
      projectDirs: [configured, repoLocal],
    });

    await mount();
    const buttons = openFolderButtons();
    expect(buttons).toHaveLength(3);
    expect(container.textContent).toContain(configured);
    expect(container.textContent).toContain(repoLocal);

    for (const button of buttons) {
      act(() => button.click());
      await flush();
    }

    expect(state.openAutoMemoryFolder.mock.calls).toEqual([
      ['project', '/workspace', configured],
      ['project', '/workspace', repoLocal],
      ['user', '/workspace', undefined],
    ]);
  });

  it('says a toggle change applies to new sessions when the write requires a restart', async () => {
    state.setValue.mockResolvedValue({
      key: 'memory.enableManagedAutoMemory',
      scope: 'user',
      value: false,
      requiresRestart: true,
    });

    await mount();
    act(() => switchByLabel('Auto-memory').click());
    await flush();

    const [region] = liveRegions();
    expect(region.textContent).toContain(
      'This change requires a restart to take effect.',
    );
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it('disables and explains a toggle whose value a higher-priority scope defines', async () => {
    // Neither the user nor the workspace value (nor the default) explains
    // the effective value: a system/managed setting does, and a write here
    // would never take effect.
    state.settings = [
      descriptor('memory.enableManagedAutoMemory', 'Auto-memory', {
        effective: false,
      }),
      descriptor('memory.enableManagedAutoDream', 'Auto-dream', {
        effective: true,
        user: false,
      }),
    ];

    await mount();

    expect(switchByLabel('Auto-memory').disabled).toBe(true);
    expect(switchByLabel('Auto-dream').disabled).toBe(true);
    expect(container.textContent).toContain(
      'Set by a higher-priority configuration; it cannot be changed here.',
    );
    act(() => switchByLabel('Auto-memory').click());
    await flush();
    expect(state.setValue).not.toHaveBeenCalled();
  });

  it('surfaces a settings load failure in the status region', async () => {
    state.settings = [];
    state.settingsError = new Error('Load settings timed out');

    await mount();

    const [region] = liveRegions();
    expect(region.textContent).toContain('Load settings timed out');
    expect(switchByLabel('Auto-memory').disabled).toBe(true);
  });

  it('re-reads a content-less entry when it is selected again', async () => {
    state.readAutoMemoryFile
      .mockResolvedValueOnce({
        scope: 'project',
        path: PROJECT_ENTRY.path,
        bytes: 512,
        contentUnavailable: 'torn',
      })
      .mockResolvedValueOnce({
        scope: 'project',
        path: PROJECT_ENTRY.path,
        bytes: 512,
        content: 'settled body\n',
      });

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();
    expect(container.textContent).toContain(
      'This entry changed while it was being read. Select it again to retry.',
    );

    act(() => entryButton('Build notes').click());
    await flush();
    expect(state.readAutoMemoryFile).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('settled body');

    // A loaded entry stays a no-op on re-select.
    act(() => entryButton('Build notes').click());
    await flush();
    expect(state.readAutoMemoryFile).toHaveBeenCalledTimes(2);
  });

  it('re-reads the open entry when the listing reports it changed, and closes it when it vanishes', async () => {
    state.readAutoMemoryFile
      .mockResolvedValueOnce({
        scope: 'project',
        path: PROJECT_ENTRY.path,
        bytes: 512,
        content: 'version one\n',
      })
      .mockResolvedValueOnce({
        scope: 'project',
        path: PROJECT_ENTRY.path,
        bytes: 600,
        content: 'version two\n',
      });

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();
    expect(container.textContent).toContain('version one');

    // A background extraction rewrote the file; the listing reloads.
    state.status = listing([
      { ...PROJECT_ENTRY, bytes: 600, modifiedAt: '2026-10-14T12:05:00.000Z' },
      USER_ENTRY,
    ]);
    rerender();
    await flush();
    expect(state.readAutoMemoryFile).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('version two');
    expect(container.textContent).not.toContain('version one');

    // Consolidation removed it: the pane closes instead of showing it.
    state.status = listing([USER_ENTRY]);
    rerender();
    await flush();
    expect(container.textContent).not.toContain('version two');
    expect(state.readAutoMemoryFile).toHaveBeenCalledTimes(2);
  });

  it('announces a read failure through a live region', async () => {
    state.readAutoMemoryFile.mockRejectedValue(new Error('read boom'));

    await mount();
    act(() => entryButton('Build notes').click());
    await flush();

    expect(
      liveRegions().some((region) => region.textContent?.includes('read boom')),
    ).toBe(true);
  });
});
