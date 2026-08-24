/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    config: {
      getContentGeneratorConfig: () => undefined,
      getModelDisplayName: () => 'model',
      getScreenReader: (): boolean => false,
      getTargetDir: () => 'workspace',
    },
    configReadCount: 0,
    renderOrder: [] as string[],
    settings: {
      merged: { ui: {} as { hideBanner?: boolean; hideTips?: boolean } },
    },
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  AuthType: {
    API_KEY: 'api-key',
    QWEN_OAUTH: 'qwen-oauth',
  },
  findProviderByCredentials: () => undefined,
  resolveMetadataKey: () => undefined,
}));

vi.mock('./Header.js', () => ({
  AuthDisplayType: {
    API_KEY: 'api-key',
    QWEN_OAUTH: 'qwen-oauth',
    UNKNOWN: 'unknown',
  },
  Header: () => {
    state.renderOrder.push('header');
    return null;
  },
}));

vi.mock('./Tips.js', () => ({
  Tips: () => {
    state.renderOrder.push('tips');
    return null;
  },
}));

vi.mock('./WhatsNew.js', () => ({
  WhatsNew: ({ version }: { version: string }) => {
    state.renderOrder.push(`whats-new:${version}`);
    return null;
  },
}));

vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => {
    state.configReadCount++;
    return state.config;
  },
}));

vi.mock('../contexts/SettingsContext.js', () => ({
  useSettings: () => state.settings,
}));

vi.mock('../utils/customBanner.js', () => ({
  resolveCustomBanner: () => undefined,
}));

import { AppHeader } from './AppHeader.js';

describe('<AppHeader /> upgrade notice', () => {
  beforeEach(() => {
    state.config.getContentGeneratorConfig = () => undefined;
    state.config.getModelDisplayName = () => 'model';
    state.config.getScreenReader = () => false;
    state.config.getTargetDir = () => 'workspace';
    state.configReadCount = 0;
    state.settings.merged.ui = {};
    state.renderOrder.length = 0;
  });

  it('renders the upgrade notice after startup tips', async () => {
    render(<AppHeader version="0.20.1" />);

    await vi.waitFor(() =>
      expect(state.renderOrder).toEqual(['header', 'tips', 'whats-new:0.20.1']),
    );
  });

  it('does not render the upgrade notice when tips are hidden', async () => {
    state.settings.merged.ui = { hideTips: true };

    render(<AppHeader version="0.20.1" />);

    await vi.waitFor(() => expect(state.renderOrder).toEqual(['header']));
  });

  it('does not render the upgrade notice in screen-reader mode', async () => {
    state.config.getScreenReader = () => true;

    render(<AppHeader version="0.20.1" />);

    await vi.waitFor(() => expect(state.configReadCount).toBeGreaterThan(0));
    expect(state.renderOrder).toEqual([]);
  });
});
