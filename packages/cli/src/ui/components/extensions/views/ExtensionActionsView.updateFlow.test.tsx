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
}

/**
 * Mirrors InstalledTab: the view's `updateState` comes from the parent map and
 * the view reports resolved states back into it.
 */
function Harness({
  manager,
  onStatus,
  controls,
}: {
  manager: ReturnType<typeof createManager>;
  onStatus: (status: StatusMessage | null) => void;
  controls: HarnessControls;
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
        onExit={vi.fn()}
        onUpdateStateChange={(name, state) =>
          dispatch({ type: 'SET_STATE', payload: { name, state } })
        }
      />
    </KeypressProvider>
  );
}

function renderDetail(
  manager: ReturnType<typeof createManager>,
  onStatus: (status: StatusMessage | null) => void = vi.fn(),
) {
  const controls: HarnessControls = { remount: () => {} };
  const { lastFrame, stdin } = render(
    <Harness manager={manager} onStatus={onStatus} controls={controls} />,
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
    manager.updateExtension.mockImplementation(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        callback(ext.name, ExtensionUpdateState.ERROR);
        throw new Error('swap failed');
      },
    );
    const statuses: Array<StatusMessage | null> = [];
    const { lastFrame, stdin } = renderDetail(manager, (status) =>
      statuses.push(status),
    );

    await selectUpdateNow(stdin, lastFrame);

    await waitFor(() =>
      expect(statuses).toContainEqual({ type: 'error', text: 'swap failed' }),
    );
    // The extension still has an update pending, so the menu must keep it.
    expect(lastFrame()).toContain('Update Now');
  });
});
