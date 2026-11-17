/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom
//
// "Update Now" flow (issue #11884): the detail view must surface a busy line
// while the update runs, and a successful update must stop the menu offering
// "Update Now" — both for the visible mount and after leaving/re-entering the
// detail view, which remounts the view and re-reads the parent's update-state
// map.
//
// Unlike ExtensionActionsView.test.tsx, this suite drives the real
// PluginDetailView / RadioButtonSelect through stdin instead of mocking them,
// and wraps the view in a harness that mirrors InstalledTab's wiring: the
// update state comes from the app's `extensionsUpdateState` map (held here by
// the real reducer), so a remount re-supplies whatever the map still says.

import { act, useReducer, useRef } from 'react';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import {
  ExtensionUpdateState,
  type Config,
  type Extension,
} from '@qwen-code/qwen-code-core';
import { KeypressProvider } from '../../../contexts/KeypressContext.js';
import {
  extensionUpdatesReducer,
  initialExtensionUpdatesState,
} from '../../../state/extensions.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';
import { ExtensionActionsView } from './ExtensionActionsView.js';

const ARROW_DOWN = '\u001B[B';
const ARROW_UP = '\u001B[A';

const extension = {
  id: 'demo-id',
  name: 'demo',
  version: '1.0.0',
  path: '/extensions/demo',
  isActive: true,
  installMetadata: { type: 'git', source: 'owner/demo' },
  mcpServers: {},
  commands: [],
  skills: [],
  agents: [],
  resolvedSettings: [],
  config: {},
  contextFiles: [],
} as unknown as Extension;

function createManager() {
  return {
    isFavorite: vi.fn(() => false),
    getExtensionScope: vi.fn(() => 'user' as const),
    updateExtension: vi.fn(),
    disableExtension: vi.fn(async () => ({ warnings: [] })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessControls {
  /** Simulates leaving the detail view and re-entering it (a fresh mount). */
  remount: () => void;
  /** Simulates the app's own background update check landing a new state. */
  setState: (state: ExtensionUpdateState) => void;
  /** The view's request to leave the detail view (InstalledTab's goToList). */
  onExit: ReturnType<typeof vi.fn>;
}

/**
 * Mirrors InstalledTab: the view's `updateState` comes from the parent map and
 * the view reports resolved states back into it.
 */
function Harness({
  manager,
  onStatus,
  controls,
  onAdopt,
}: {
  manager: ReturnType<typeof createManager>;
  onStatus: (status: StatusMessage | null) => void;
  controls: HarnessControls;
  /** Observes what the view reports as the state the update settled on. */
  onAdopt?: (name: string, state: string) => void;
}) {
  const [map, dispatch] = useReducer(extensionUpdatesReducer, {
    ...initialExtensionUpdatesState,
    extensionStatuses: new Map([
      [
        extension.name,
        { status: ExtensionUpdateState.UPDATE_AVAILABLE, processed: true },
      ],
    ]),
  });
  const [mount, setMount] = useReducer((count: number) => count + 1, 0);
  const controlsRef = useRef(controls);
  controlsRef.current.remount = () => setMount();
  controlsRef.current.setState = (state: ExtensionUpdateState) =>
    dispatch({ type: 'SET_STATE', payload: { name: extension.name, state } });

  const config = {
    getExtensionManager: () => manager,
  } as unknown as Config;

  return (
    <KeypressProvider kittyProtocolEnabled={false}>
      <ExtensionActionsView
        key={mount}
        config={config}
        extension={extension}
        isActive
        updateState={map.extensionStatuses.get(extension.name)?.status}
        onStatus={onStatus}
        onReload={vi.fn()}
        onExit={controls.onExit}
        onUpdateStateChange={(name, state) => {
          onAdopt?.(name, state);
          dispatch({ type: 'SET_STATE', payload: { name, state } });
        }}
      />
    </KeypressProvider>
  );
}

function renderDetail(
  manager: ReturnType<typeof createManager>,
  onStatus: (status: StatusMessage | null) => void = vi.fn(),
  onAdopt?: (name: string, state: string) => void,
) {
  const controls: HarnessControls = {
    remount: () => {},
    setState: () => {},
    onExit: vi.fn(),
  };
  const { lastFrame, stdin } = render(
    <Harness
      manager={manager}
      onStatus={onStatus}
      controls={controls}
      onAdopt={onAdopt}
    />,
  );
  return { lastFrame, stdin, controls };
}

async function selectUpdateNow(
  stdin: { write: (data: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  await waitFor(() => expect(lastFrame()).toContain('Update Now'));
  // Actions: Disable, Add to Favorites, Change scope, Mark for Update,
  // Update Now — the update entry sits at index 4.
  for (let i = 0; i < 4; i++) {
    stdin.write(ARROW_DOWN);
  }
  stdin.write('\r');
}

/** The label of the row the list is pointing at, read off its `›` marker. */
function cursorRow(lastFrame: () => string | undefined): string {
  const line = lastFrame()
    ?.split('\n')
    .find((row) => row.includes('›'));
  return line?.replace('›', '').trim() ?? '';
}

describe('ExtensionActionsView update flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a busy line while the update runs and ignores a second Enter', async () => {
    const manager = createManager();
    const pending = deferred<{ warnings?: unknown[] }>();
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        await pending.promise;
        callback(ext.name, ExtensionUpdateState.UPDATED);
        return {
          name: ext.name,
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        };
      },
    );
    const { lastFrame, stdin } = renderDetail(manager);

    await selectUpdateNow(stdin, lastFrame);

    await waitFor(() => expect(manager.updateExtension).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('Updating demo...');

    // The action list (and its focused select) is gone while the update runs,
    // so a second Enter cannot start a concurrent update.
    stdin.write('\r');
    await act(async () => {});
    expect(manager.updateExtension).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve({});
    });
    await waitFor(() => expect(lastFrame()).not.toContain('Updating demo...'));
  });

  it('stops offering "Update Now" after a successful update', async () => {
    const manager = createManager();
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        callback(ext.name, ExtensionUpdateState.UPDATED);
        return {
          name: ext.name,
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        };
      },
    );
    const statuses: Array<StatusMessage | null> = [];
    const { lastFrame, stdin, controls } = renderDetail(manager, (status) =>
      statuses.push(status),
    );

    await selectUpdateNow(stdin, lastFrame);

    await waitFor(() => expect(lastFrame()).not.toContain('Update Now'));
    expect(statuses).toContainEqual({
      type: 'success',
      text: 'Updated "demo".',
    });

    // Leaving the detail view and coming back remounts the view; the parent
    // map must not re-supply the superseded "update available" state.
    await act(async () => {
      controls.remount();
    });
    await waitFor(() => expect(lastFrame()).toContain('Mark for Update'));
    expect(lastFrame()).not.toContain('Update Now');
  });

  it('keeps offering "Update Now" when the update fails', async () => {
    const manager = createManager();
    const pending = deferred<void>();
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        // Keep the update in flight long enough for the busy line to paint, so
        // the action list really is unmounted and remounted here.
        await pending.promise;
        callback(ext.name, ExtensionUpdateState.ERROR);
        throw new Error('swap failed');
      },
    );
    const statuses: Array<StatusMessage | null> = [];
    const { lastFrame, stdin } = renderDetail(manager, (status) =>
      statuses.push(status),
    );

    await selectUpdateNow(stdin, lastFrame);
    await waitFor(() => expect(lastFrame()).toContain('Updating demo...'));

    await act(async () => {
      pending.resolve();
    });
    await waitFor(() =>
      expect(statuses).toContainEqual({ type: 'error', text: 'swap failed' }),
    );
    // The extension still has an update pending, so the menu must keep it.
    await waitFor(() => expect(lastFrame()).toContain('Update Now'));

    // The busy line unmounted the action list and it is remounted here with the
    // same rows, so the cursor has to come back on "Update Now" too: a bare
    // Enter retries the update instead of running the row that sits first.
    stdin.write('\r');
    await waitFor(() =>
      expect(manager.updateExtension).toHaveBeenCalledTimes(2),
    );
    expect(manager.disableExtension).not.toHaveBeenCalled();
  });

  it('keeps the cursor on its row when a row disappears under the mounted list', async () => {
    const manager = createManager();
    const pending = deferred<void>();
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        // Held in flight long enough for the busy line to paint, so the action
        // list really is unmounted and remounted by the time it fails.
        await pending.promise;
        callback(ext.name, ExtensionUpdateState.ERROR);
        throw new Error('swap failed');
      },
    );
    const { lastFrame, stdin, controls } = renderDetail(manager);

    await selectUpdateNow(stdin, lastFrame);
    await act(async () => {
      pending.resolve();
    });
    // The list is back, seeded with the row the user activated.
    await waitFor(() => expect(lastFrame()).toContain('Update Now'));
    expect(cursorRow(lastFrame)).toBe('Update Now');

    // Move off it. From here on the list is NOT remounted — the only thing that
    // changes is the row set itself.
    stdin.write(ARROW_UP);
    await act(async () => {});
    expect(cursorRow(lastFrame)).toBe('Mark for Update');

    // The app's own background check lands and takes "Update Now" away under
    // the mounted list. The cursor seed must not be re-derived from the rows
    // now on screen: a changed seed reads as "move the cursor here" and would
    // drag the highlight to the first row instead.
    await act(async () => {
      controls.setState(ExtensionUpdateState.UPDATED);
    });
    await waitFor(() => expect(lastFrame()).not.toContain('Update Now'));
    expect(cursorRow(lastFrame)).toBe('Mark for Update');

    // And the keys that follow must run the row under the cursor, one up from
    // here — not first-row "Disable", which `toggle` runs with no confirmation
    // step at all.
    stdin.write(ARROW_UP);
    await act(async () => {});
    expect(cursorRow(lastFrame)).toBe('Change scope');
    stdin.write('\r');
    await waitFor(() =>
      expect(lastFrame()).toContain('Change scope for "demo":'),
    );
    expect(manager.disableExtension).not.toHaveBeenCalled();
  });

  it('cancels a stalled update on Escape instead of ignoring the key', async () => {
    const manager = createManager();
    let signal: AbortSignal | undefined;
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
        _enableReloading?: boolean,
        abortSignal?: AbortSignal,
      ) => {
        signal = abortSignal;
        callback(ext.name, ExtensionUpdateState.UPDATING);
        // A fetch that stalls rather than fails, and that only settles when it
        // is cancelled — the shape the manager's own signal support exists for
        // (the git client hands the signal to the fetch underneath).
        await new Promise<never>((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        });
        return undefined;
      },
    );
    const statuses: Array<StatusMessage | null> = [];
    const { lastFrame, stdin, controls } = renderDetail(manager, (status) =>
      statuses.push(status),
    );

    await selectUpdateNow(stdin, lastFrame);
    await waitFor(() => expect(manager.updateExtension).toHaveBeenCalledOnce());
    expect(lastFrame()).toContain('Updating demo...');

    // Escape must reach the run, not be swallowed: leaving instead would
    // unmount the view while the update keeps running and let a second one
    // start from a fresh mount, so the guard's invariant is that Escape does
    // NOT exit here — it cancels the wait.
    stdin.write('\x1b');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(signal?.aborted).toBe(true);
    expect(controls.onExit).not.toHaveBeenCalled();

    // The cancellation settles the operation, so the guard lifts: the busy line
    // goes away, the status line reports the failure, and the extension is
    // still offered as updatable (an aborted run must not read as success).
    await waitFor(() => expect(lastFrame()).not.toContain('Updating demo...'));
    expect(statuses).toContainEqual({
      type: 'error',
      text: 'This operation was aborted',
    });
    expect(lastFrame()).toContain('Update Now');

    // Control: with nothing in flight, Escape does reach the view and leaves
    // the detail — so the assertion above is about the in-flight guard, not
    // about a keypress that never arrived.
    stdin.write('\x1b');
    await waitFor(() => expect(controls.onExit).toHaveBeenCalledOnce());
  });

  it.each([
    [
      ExtensionUpdateState.UPDATED_WITH_WARNINGS,
      'Updated "demo" with warnings: extension_reload_failed: boom.',
    ],
    [
      ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      'Updated "demo" with warnings: extension_reload_failed: boom.',
    ],
  ])(
    'adopts %s — the state the manager settled on — not a constant',
    async (settledState, expectedStatus) => {
      const manager = createManager();
      manager.updateExtension.mockImplementation(
        async (
          ext: Extension,
          _state: ExtensionUpdateState,
          callback: (name: string, state: ExtensionUpdateState) => void,
        ) => {
          callback(ext.name, ExtensionUpdateState.UPDATING);
          callback(ext.name, settledState);
          return {
            name: ext.name,
            originalVersion: '1.0.0',
            updatedVersion: '1.0.1',
            warnings: [
              { code: 'extension_reload_failed', error: 'boom' },
            ] as unknown[],
          };
        },
      );
      const statuses: Array<StatusMessage | null> = [];
      const adopted: Array<[string, string]> = [];
      const { lastFrame, stdin } = renderDetail(
        manager,
        (status) => statuses.push(status),
        (name, state) => adopted.push([name, state]),
      );

      await selectUpdateNow(stdin, lastFrame);

      // The app-level map (and the parent) must record the manager's terminal
      // state, not "updated": a restart/warning outcome that got flattened to
      // "updated" would be rendered as a success and never flagged as needing
      // attention.
      await waitFor(() => expect(adopted).toEqual([['demo', settledState]]));
      expect(statuses).toContainEqual({
        type: 'warning',
        text: expectedStatus,
      });
      await waitFor(() => expect(lastFrame()).not.toContain('Update Now'));
    },
  );
});
