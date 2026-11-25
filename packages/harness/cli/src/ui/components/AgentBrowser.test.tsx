/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, Config } from '@qwen-code/core';
import { emptySnapshotSource } from '../../../../core/src/test-utils/listed-model.js';
import { cleanup, renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { AgentBrowser } from './AgentBrowser.js';

const FAKE_KEY = {
  name: 'c',
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
  insertable: true,
  sequence: 'c',
};

describe('AgentBrowser', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not reload the agent registry when toggling fails to persist', async () => {
    const definition = {
      name: 'built-in-agent',
      description: 'built-in agent',
      kind: 'local',
      modelConfig: { model: 'inherit' },
      metadata: { source: 'built-in' },
    } as AgentDefinition;
    const reload = vi.fn().mockResolvedValue(undefined);
    const registry = {
      getAllAgentNames: vi.fn().mockReturnValue(['built-in-agent']),
      getAllDiscoveredDefinitions: vi.fn().mockReturnValue([definition]),
      getDefinition: vi.fn().mockReturnValue(definition),
      getLoadErrors: vi.fn().mockReturnValue([]),
      reload,
    };
    const config = {
      getModelProviderManager: emptySnapshotSource.getModelProviderManager,
      getAgentRegistry: vi.fn().mockReturnValue(registry),
    } as unknown as Config;
    const settings = createMockSettings();
    settings.mutateScope = vi.fn().mockReturnValue(false);

    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentBrowser
          config={config}
          settings={settings}
          activeSourceTab="built-in"
          onSourceTabChange={vi.fn()}
          onOpenConfig={vi.fn()}
          onExit={vi.fn()}
        />,
        { settings },
      );
    await waitUntilReady();
    await act(async () => {
      capturedRegistry?.invokeFallback('Dialog', FAKE_KEY);
    });
    await waitUntilReady();

    expect(settings.mutateScope).toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    unmount();
  });
});
