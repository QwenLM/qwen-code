/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { ExtensionListStep } from './ExtensionListStep.js';
import { KeypressProvider } from '../../../contexts/KeypressContext.js';
import type { Extension } from '@qwen-code/qwen-code-core';
import { ExtensionUpdateState } from '../../../state/extensions.js';

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

describe('ExtensionListStep Snapshots', () => {
  const baseProps = {
    onExtensionSelect: vi.fn(),
  };

  it('should render empty state', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ExtensionListStep
          extensions={[]}
          extensionsUpdateState={new Map()}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render list with single extension', () => {
    const extensions = [createMockExtension('test-extension', true)];
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ExtensionListStep
          extensions={extensions}
          extensionsUpdateState={new Map()}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render list with multiple extensions', () => {
    const extensions = [
      createMockExtension('active-extension', true),
      createMockExtension('disabled-extension', false),
      createMockExtension('update-available', true),
    ];
    const updateState = new Map([
      ['active-extension', ExtensionUpdateState.UP_TO_DATE],
      ['disabled-extension', ExtensionUpdateState.NOT_UPDATABLE],
      ['update-available', ExtensionUpdateState.UPDATE_AVAILABLE],
    ]);

    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ExtensionListStep
          extensions={extensions}
          extensionsUpdateState={updateState}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render with checking status', () => {
    const extensions = [createMockExtension('checking-extension', true)];
    const updateState = new Map([
      ['checking-extension', ExtensionUpdateState.CHECKING_FOR_UPDATES],
    ]);

    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ExtensionListStep
          extensions={extensions}
          extensionsUpdateState={updateState}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render with error status', () => {
    const extensions = [createMockExtension('error-extension', true)];
    const updateState = new Map([
      ['error-extension', ExtensionUpdateState.ERROR],
    ]);

    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ExtensionListStep
          extensions={extensions}
          extensionsUpdateState={updateState}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });
});
