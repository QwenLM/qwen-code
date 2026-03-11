/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtensionsManagerDialog } from './ExtensionsManagerDialog.js';
import { UIStateContext } from '../../contexts/UIStateContext.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type { Config, Extension } from '@qwen-code/qwen-code-core';
import { ExtensionUpdateState } from '../../state/extensions.js';

const createMockExtension = (
  name: string,
  isActive = true,
  version = '1.0.0',
): Extension =>
  ({
    id: name,
    name,
    version,
    path: `/home/user/.qwen/extensions/${name}`,
    isActive,
    installMetadata: {
      type: 'git',
      source: `github:user/${name}`,
    },
    mcpServers: {},
    commands: [],
    skills: [],
    agents: [],
    resolvedSettings: [],
    config: {},
    contextFiles: [],
  }) as unknown as Extension;

const createMockConfig = (extensions: Extension[] = []): Config =>
  ({
    getExtensions: () => extensions,
    getExtensionManager: () => ({
      getLoadedExtensions: () => extensions,
      refreshCache: vi.fn().mockResolvedValue(undefined),
      checkForAllExtensionUpdates: vi.fn().mockResolvedValue(undefined),
      disableExtension: vi.fn().mockResolvedValue(undefined),
      enableExtension: vi.fn().mockResolvedValue(undefined),
      uninstallExtension: vi.fn().mockResolvedValue(undefined),
      updateExtension: vi.fn().mockResolvedValue(undefined),
    }),
    getLoadedExtensions: () => extensions,
  }) as unknown as Config;

const createMockUIState = (
  extensionsUpdateState = new Map<string, ExtensionUpdateState>(),
): UIState =>
  ({
    extensionsUpdateState,
  }) as unknown as UIState;

describe('ExtensionsManagerDialog Snapshots', () => {
  const baseProps = {
    onClose: vi.fn(),
    config: createMockConfig(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render empty state when no extensions installed', () => {
    const uiState = createMockUIState();
    const { lastFrame } = render(
      <UIStateContext.Provider value={uiState}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <ExtensionsManagerDialog {...baseProps} />
        </KeypressProvider>
      </UIStateContext.Provider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render extension list with extensions', () => {
    const extensions = [
      createMockExtension('test-extension', true),
      createMockExtension('another-extension', false),
    ];
    const uiState = createMockUIState(
      new Map([
        ['test-extension', ExtensionUpdateState.UP_TO_DATE],
        ['another-extension', ExtensionUpdateState.UPDATE_AVAILABLE],
      ]),
    );
    const { lastFrame } = render(
      <UIStateContext.Provider value={uiState}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <ExtensionsManagerDialog
            {...baseProps}
            config={createMockConfig(extensions)}
          />
        </KeypressProvider>
      </UIStateContext.Provider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render with update available status', () => {
    const extensions = [createMockExtension('outdated-extension', true)];
    const uiState = createMockUIState(
      new Map([['outdated-extension', ExtensionUpdateState.UPDATE_AVAILABLE]]),
    );
    const { lastFrame } = render(
      <UIStateContext.Provider value={uiState}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <ExtensionsManagerDialog
            {...baseProps}
            config={createMockConfig(extensions)}
          />
        </KeypressProvider>
      </UIStateContext.Provider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render with checking status', () => {
    const extensions = [createMockExtension('checking-extension', true)];
    const uiState = createMockUIState(
      new Map([
        ['checking-extension', ExtensionUpdateState.CHECKING_FOR_UPDATES],
      ]),
    );
    const { lastFrame } = render(
      <UIStateContext.Provider value={uiState}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <ExtensionsManagerDialog
            {...baseProps}
            config={createMockConfig(extensions)}
          />
        </KeypressProvider>
      </UIStateContext.Provider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });
});
