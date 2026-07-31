/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { ActionSelectionStep } from './ActionSelectionStep.js';
import { KeypressProvider } from '../../../contexts/KeypressContext.js';
import type { Extension } from '@qwen-code/qwen-code-core';

const createMockExtension = (name: string, isActive = true): Extension =>
  ({
    id: name,
    name,
    version: '1.0.0',
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

describe('ActionSelectionStep Snapshots', () => {
  const baseProps = {
    onNavigateToStep: vi.fn(),
    onNavigateBack: vi.fn(),
    onActionSelect: vi.fn(),
  };

  it('should render for active extension without update', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ActionSelectionStep
          selectedExtension={createMockExtension('active-ext', true)}
          hasUpdateAvailable={false}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render for disabled extension', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ActionSelectionStep
          selectedExtension={createMockExtension('disabled-ext', false)}
          hasUpdateAvailable={false}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render for extension with update available', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ActionSelectionStep
          selectedExtension={createMockExtension('update-ext', true)}
          hasUpdateAvailable={true}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render for disabled extension with update', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ActionSelectionStep
          selectedExtension={createMockExtension('disabled-update-ext', false)}
          hasUpdateAvailable={true}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should render with no extension selected', () => {
    const { lastFrame } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <ActionSelectionStep
          selectedExtension={null}
          hasUpdateAvailable={false}
          {...baseProps}
        />
      </KeypressProvider>,
    );

    expect(lastFrame()).toMatchSnapshot();
  });
});
