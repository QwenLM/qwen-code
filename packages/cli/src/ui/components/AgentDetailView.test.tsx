/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition, AgentSource, Config } from '@qwen-code/core';
import { AgentDetailView } from './AgentDetailView.js';
import { AgentDetailEditor } from './AgentDetailEditor.js';
import {
  createAgentEnabledField,
  createAgentModelField,
} from './agentDetailFields.js';
import { renderWithProviders, cleanup } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';
import type { ActionHandlerRegistryImpl } from '../contexts/ActionHandlerRegistry.js';
import type { Key } from '../contexts/KeypressContext.js';

const FAKE_KEY: Key = {
  name: '',
  shift: false,
  alt: false,
  ctrl: false,
  cmd: false,
  insertable: false,
  sequence: '',
};

function makeDefinition(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name: 'test-agent',
    description: 'Test agent',
    kind: 'local',
    experimental: false,
    modelConfig: {
      model: 'inherit',
    },
    runConfig: {},
    metadata: {
      source: 'built-in',
    },
    ...overrides,
  } as AgentDefinition;
}

function makeConfig(activeDefinition?: AgentDefinition): Config {
  return {
    getModelRequestIdentity: vi.fn(() => 'test-owner'),
    getSessionId: vi.fn(() => 'test-session'),
    getModel: vi.fn(() => 'auto'),
    getModelProviderManager: vi.fn(() => ({
      listModels: vi.fn(async () => []),
    })),
    getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: undefined }),
    getAgentRegistry: vi.fn().mockReturnValue({
      getDefinition: vi.fn().mockReturnValue(activeDefinition),
      reload: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Config;
}

async function focusRunAgent(
  registry: ActionHandlerRegistryImpl | undefined,
  waitUntilReady: () => Promise<void>,
) {
  await act(async () => {
    for (let i = 0; i < 8; i++) {
      registry?.invokeAction('Dialog', 'dialog:navigate:down', FAKE_KEY);
    }
  });
  await waitUntilReady();
}

async function focusMaxTurns(
  registry: ActionHandlerRegistryImpl | undefined,
  waitUntilReady: () => Promise<void>,
) {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      registry?.invokeAction('Dialog', 'dialog:navigate:down', FAKE_KEY);
    }
  });
  await waitUntilReady();
}

describe('AgentDetailView', () => {
  afterEach(() => {
    cleanup();
  });

  it('edits the supplied model options without querying the provider directory', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(true);
    const config = makeConfig(definition);
    const custom = testListedModel('gateway/main', {
      source: 'custom',
      provider: 'gateway',
      display_name: 'Gateway model',
    });
    vi.mocked(config.getModel).mockReturnValue(custom.key);
    vi.mocked(config.getModelProviderManager).mockReturnValue({
      listModels: vi.fn(async () => [testListedModel('qmodel-other'), custom]),
    } as unknown as ReturnType<Config['getModelProviderManager']>);
    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailEditor
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source="built-in"
          config={config}
          settings={settings}
          onClose={vi.fn()}
          fields={[
            createAgentEnabledField(),
            createAgentModelField([
              { label: 'inherit', value: 'inherit' },
              { label: custom.displayName, value: custom.key },
            ]),
          ]}
        />,
        { settings },
      );
    try {
      await waitUntilReady();
      await act(async () => {
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:down',
          FAKE_KEY,
        );
      });
      await waitUntilReady();
      await act(async () => {
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:right',
          FAKE_KEY,
        );
      });
      await waitUntilReady();
      expect(settings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        ['agents', 'overrides', 'test-agent', 'modelConfig', 'model'],
        custom.key,
      );
      expect(config.getModelProviderManager).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it('shows the effective default max turns', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();

    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDetailView
        agentName="test-agent"
        description="Test agent"
        definition={definition}
        source={definition.metadata?.source}
        config={makeConfig(definition)}
        settings={settings}
        onClose={vi.fn()}
      />,
      { settings },
    );

    expect(lastFrame()).toContain('150 (default)');
    for (const label of [
      'Temperature',
      'Top P',
      'Top K',
      'Max Output Tokens',
    ]) {
      expect(lastFrame()).toContain(label);
    }
    unmount();
  });

  it('steps max turns through presets with the left and right arrows', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(true);

    const { capturedRegistry, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source={definition.metadata?.source}
          config={makeConfig(definition)}
          settings={settings}
          onClose={vi.fn()}
        />,
        { settings },
      );

    await focusMaxTurns(capturedRegistry, waitUntilReady);
    expect(lastFrame()).toContain('←/→ quick adjust · Enter custom value');
    await act(async () => {
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:left',
        FAKE_KEY,
      );
    });
    await waitUntilReady();

    expect(settings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      ['agents', 'overrides', 'test-agent', 'runConfig', 'maxTurns'],
      200,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      ['agents', 'overrides', 'test-agent', 'runConfig', 'maxTurns'],
      100,
    );
    unmount();
  });

  it('accepts a custom positive integer for max turns', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(true);

    const { capturedRegistry, lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source={definition.metadata?.source}
          config={makeConfig(definition)}
          settings={settings}
          onClose={vi.fn()}
        />,
        { settings },
      );

    await focusMaxTurns(capturedRegistry, waitUntilReady);
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', FAKE_KEY);
    });
    await waitUntilReady();
    expect(lastFrame()).toContain('Enter Max Turns');

    await act(async () => {
      stdin.write('250');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(settings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      ['agents', 'overrides', 'test-agent', 'runConfig', 'maxTurns'],
      250,
    );
    unmount();
  });

  it('keeps the custom max turns input open when saving fails', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(false);
    const config = makeConfig(definition);
    const onSave = vi.fn();

    const { capturedRegistry, lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source={definition.metadata?.source}
          config={config}
          settings={settings}
          onClose={vi.fn()}
          onSave={onSave}
        />,
        { settings },
      );

    await focusMaxTurns(capturedRegistry, waitUntilReady);
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', FAKE_KEY);
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('250');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(settings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      ['agents', 'overrides', 'test-agent', 'runConfig', 'maxTurns'],
      250,
    );
    expect(lastFrame()).toContain('Enter Max Turns');
    expect(onSave).not.toHaveBeenCalled();
    expect(config.getAgentRegistry()?.reload).not.toHaveBeenCalled();
    unmount();
  });

  it('rejects a non-positive custom max turns value', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();
    settings.setValue = vi.fn().mockReturnValue(true);

    const { capturedRegistry, lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source={definition.metadata?.source}
          config={makeConfig(definition)}
          settings={settings}
          onClose={vi.fn()}
        />,
        { settings },
      );

    await focusMaxTurns(capturedRegistry, waitUntilReady);
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', FAKE_KEY);
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('0');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('Max Turns must be a positive integer.');
    expect(settings.setValue).not.toHaveBeenCalled();
    unmount();
  });

  it('disables Run Agent when the selected agent is disabled', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings({
      agents: {
        overrides: {
          'test-agent': { enabled: false },
        },
      },
    });
    const onRunAgent = vi.fn();

    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDetailView
        agentName="test-agent"
        description="Test agent"
        definition={definition}
        source={definition.metadata?.source}
        config={makeConfig()}
        settings={settings}
        onClose={vi.fn()}
        onRunAgent={onRunAgent}
      />,
      { settings },
    );

    expect(lastFrame()).toContain('(disabled agent, cannot run)');
    expect(onRunAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('allows Run Agent when the selected agent is actively loaded', async () => {
    const definition = makeDefinition();
    const settings = createMockSettings();

    const { lastFrame, capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          source={definition.metadata?.source}
          config={makeConfig(definition)}
          settings={settings}
          onClose={vi.fn()}
          onRunAgent={vi.fn()}
        />,
        { settings },
      );

    await focusRunAgent(capturedRegistry, waitUntilReady);
    await act(async () => {
      capturedRegistry?.invokeAction('Dialog', 'dialog:confirm', FAKE_KEY);
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('Enter query for test-agent');
    unmount();
  });

  it('disables Run Agent when the selected definition is shadowed', async () => {
    const definition = makeDefinition({
      metadata: {
        source: 'user' satisfies AgentSource,
      },
    });
    const activeProjectDefinition = makeDefinition({
      metadata: {
        source: 'project' satisfies AgentSource,
      },
    });
    const settings = createMockSettings();

    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDetailView
        agentName="test-agent"
        description="Test agent"
        definition={definition}
        source={definition.metadata?.source}
        config={makeConfig(activeProjectDefinition)}
        settings={settings}
        onClose={vi.fn()}
        onRunAgent={vi.fn()}
      />,
      { settings },
    );

    expect(lastFrame()).toContain('(shadowed agent, cannot run)');
    unmount();
  });

  it('renders --agents configuration values as read-only', async () => {
    const definition = makeDefinition({
      modelConfig: {
        model: 'test-model',
      },
      runConfig: {
        maxTurns: 25,
        maxTimeMinutes: 10,
      },
      metadata: {
        source: 'flag',
        filePath: '--agents:test-agent',
      },
    });
    const settings = createMockSettings();

    const { lastFrame, unmount } = await renderWithProviders(
      <AgentDetailView
        agentName="test-agent"
        description="Test agent"
        definition={definition}
        filePath={definition.metadata?.filePath}
        source={definition.metadata?.source}
        config={makeConfig(definition)}
        settings={settings}
        onClose={vi.fn()}
      />,
      { settings },
    );

    const frame = lastFrame();
    expect(frame).toContain('Yes (read-only)');
    expect(frame).toContain('test-model (read-only)');
    expect(frame).toContain('25 (read-only)');
    expect(frame).toContain('10 (read-only)');
    expect(frame).toContain('Values provided by --agents are read-only.');
    unmount();
  });

  it('does not write overrides for --agents configuration fields', async () => {
    const setValue = vi.fn();
    const definition = makeDefinition({
      runConfig: {
        maxTurns: 10,
        maxTimeMinutes: 5,
      },
      metadata: {
        source: 'flag',
        filePath: '--agents:test-agent',
      },
    });
    const settings = createMockSettings();
    settings.setValue = setValue;

    const { capturedRegistry, waitUntilReady, unmount } =
      await renderWithProviders(
        <AgentDetailView
          agentName="test-agent"
          description="Test agent"
          definition={definition}
          filePath={definition.metadata?.filePath}
          source={definition.metadata?.source}
          config={makeConfig(definition)}
          settings={settings}
          onClose={vi.fn()}
        />,
        { settings },
      );

    await act(async () => {
      // Enabled
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );
      capturedRegistry?.invokeFallback('Dialog', {
        ...FAKE_KEY,
        name: 'backspace',
      });

      // Model
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:down',
        FAKE_KEY,
      );
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );

      // Max Turns
      for (let i = 0; i < 5; i++) {
        capturedRegistry?.invokeAction(
          'Dialog',
          'dialog:navigate:down',
          FAKE_KEY,
        );
      }
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );

      // Max Time
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:down',
        FAKE_KEY,
      );
      capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:navigate:right',
        FAKE_KEY,
      );
      capturedRegistry?.invokeFallback('Dialog', {
        ...FAKE_KEY,
        name: 'backspace',
      });
    });
    await waitUntilReady();

    expect(setValue).not.toHaveBeenCalled();
    unmount();
  });
});
