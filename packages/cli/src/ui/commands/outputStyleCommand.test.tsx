/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, OutputStyleConfig } from '@qwen-code/core';
import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { OutputStyleBrowserProps } from '../components/OutputStyleBrowser.js';
import { outputStyleCommand } from './outputStyleCommand.js';

const projectStyle: OutputStyleConfig = {
  name: 'concise',
  description: 'Keep answers concise',
  prompt: 'BE_CONCISE',
  source: 'projectSettings',
};

const styles: Record<string, OutputStyleConfig | null> = {
  default: null,
  concise: projectStyle,
};
const definitions = [projectStyle];

function createConfig(
  availableStyles: Record<string, OutputStyleConfig | null> = styles,
  availableDefinitions: OutputStyleConfig[] = Object.values(
    availableStyles,
  ).filter((style): style is OutputStyleConfig => style !== null),
): Config {
  return {
    getAvailableOutputStyles: vi.fn().mockResolvedValue(availableStyles),
    getAvailableOutputStyleDefinitions: vi
      .fn()
      .mockResolvedValue(availableDefinitions),
    getOutputStyle: vi.fn().mockReturnValue(projectStyle),
    setRequestedOutputStyleName: vi.fn(),
  } as unknown as Config;
}

async function openCommand(config: Config, localOutputStyle?: string) {
  const context = createMockCommandContext({
    services: {
      agentContext: { config },
    },
  });
  vi.mocked(context.services.settings.forScope).mockReturnValue({
    settings: localOutputStyle ? { outputStyle: localOutputStyle } : {},
  } as never);
  const result = await outputStyleCommand.action?.(context, '');
  if (!result || result.type !== 'custom_dialog') {
    throw new Error('Expected output-style command to open a custom dialog');
  }
  if (!isValidElement<OutputStyleBrowserProps>(result.component)) {
    throw new Error('Expected a valid OutputStyleBrowser element');
  }
  return { context, props: result.component.props };
}

describe('outputStyleCommand', () => {
  it('registers as an auto-executed local JSX command', () => {
    expect(outputStyleCommand).toMatchObject({
      name: 'output-style',
      autoExecute: true,
      bridgeCommandType: 'local-jsx',
      requiredStartupGates: ['commands'],
    });
  });

  it('shows both the active style and the configured project style', async () => {
    const config = createConfig();

    const { props } = await openCommand(config, 'default');

    expect(config.getAvailableOutputStyles).toHaveBeenCalledOnce();
    expect(config.getAvailableOutputStyleDefinitions).toHaveBeenCalledOnce();
    expect(props.styles).toEqual(styles);
    expect(props.definitions).toEqual(definitions);
    expect(props.activeStyleName).toBe('concise');
    expect(props.configuredStyleName).toBe('default');
  });

  it('persists a selected name for the next conversation and explains when it applies', async () => {
    const config = createConfig();
    const { context, props } = await openCommand(config);

    await props.onSelect('concise', projectStyle);

    expect(context.services.settings.setValue).toHaveBeenCalledWith(
      SettingScope.Local,
      'outputStyle',
      'concise',
    );
    expect(config.setRequestedOutputStyleName).toHaveBeenCalledWith('concise');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Run /clear or /new'),
      }),
      expect.any(Number),
    );
  });

  it('persists default for the next conversation', async () => {
    const config = createConfig();
    const { context, props } = await openCommand(config);

    await props.onSelect('default', null);

    expect(context.services.settings.setValue).toHaveBeenCalledWith(
      SettingScope.Local,
      'outputStyle',
      'default',
    );
    expect(config.setRequestedOutputStyleName).toHaveBeenCalledWith('default');
  });

  it('does not report success when saving fails', async () => {
    const config = createConfig();
    const { context, props } = await openCommand(config);
    vi.mocked(context.services.settings.setValue).mockReturnValue(false);

    await props.onSelect('default', null);
    expect(config.setRequestedOutputStyleName).not.toHaveBeenCalled();
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('does not replace the requested style when confirming a forced style', async () => {
    const forcedStyle: OutputStyleConfig = {
      name: 'policy:required',
      description: 'Required by policy',
      prompt: 'REQUIRED',
      source: 'plugin',
      pluginName: 'policy',
      forceForPlugin: true,
    };
    const config = createConfig({
      default: null,
      'policy:required': forcedStyle,
    });
    const { context, props } = await openCommand(config);

    await props.onSelect('policy:required', forcedStyle);

    expect(context.services.settings.setValue).not.toHaveBeenCalled();
    expect(config.setRequestedOutputStyleName).not.toHaveBeenCalled();
  });

  it('returns an error when configuration is unavailable', async () => {
    const context = createMockCommandContext();

    const result = await outputStyleCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });

  it('returns an error when available styles cannot be loaded', async () => {
    const config = createConfig();
    vi.mocked(config.getAvailableOutputStyles).mockRejectedValue(
      new Error('load failed'),
    );
    const context = createMockCommandContext({
      services: { agentContext: { config } },
    });

    const result = await outputStyleCommand.action?.(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Unable to load output styles: load failed',
    });
  });
});
