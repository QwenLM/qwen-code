/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, expect, it, vi } from 'vitest';

const getPluginDataDir = vi.hoisted(() => vi.fn(() => '/data/plugin'));
vi.mock('../../../plugins/pluginDirectories.js', () => ({ getPluginDataDir }));

import { getPluginEnvironment } from './support.js';

beforeEach(() => getPluginDataDir.mockClear());

it('supplies Qwen plugin paths to MCP processes', () => {
  expect(getPluginEnvironment({
    name: 'demo',
    path: '/plugins/demo',
    id: 'demo@local',
  })).toEqual({
    QWEN_PLUGIN_ROOT: '/plugins/demo',
    QWEN_PLUGIN_DATA: '/data/plugin',
    CLAUDE_PLUGIN_ROOT: '/plugins/demo',
    CLAUDE_PLUGIN_DATA: '/data/plugin',
  });
  expect(getPluginDataDir).toHaveBeenCalledWith('demo@local');
});

it('does not allocate plugin data for an empty owner id', () => {
  expect(getPluginEnvironment({
    name: 'demo',
    path: '/plugins/demo',
    id: '',
  })).toEqual({
    QWEN_PLUGIN_ROOT: '/plugins/demo',
    CLAUDE_PLUGIN_ROOT: '/plugins/demo',
  });
  expect(getPluginDataDir).not.toHaveBeenCalled();
});
