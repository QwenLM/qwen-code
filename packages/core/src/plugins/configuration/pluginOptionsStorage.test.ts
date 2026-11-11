/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPluginDataDir = vi.fn((id: string) => `/data/${id}`);

vi.mock('../pluginDirectories.js', () => ({
  getPluginDataDir: (id: string) => getPluginDataDir(id),
}));

import { substitutePluginVariables } from './pluginOptionsStorage.js';

describe('substitutePluginVariables', () => {
  beforeEach(() => {
    getPluginDataDir.mockClear();
  });

  it('substitutes ${QWEN_PLUGIN_ROOT} and ${QWEN_PLUGIN_DATA}', () => {
    const out = substitutePluginVariables(
      'root=${QWEN_PLUGIN_ROOT} data=${QWEN_PLUGIN_DATA}',
      { path: '/plugins/demo', pluginId: 'demo@local' },
    );
    expect(out).toBe('root=/plugins/demo data=/data/demo@local');
    expect(getPluginDataDir).toHaveBeenCalledWith('demo@local');
  });

  it('substitutes the ${CLAUDE_*} aliases for upstream plugins', () => {
    const out = substitutePluginVariables(
      'root=${CLAUDE_PLUGIN_ROOT} data=${CLAUDE_PLUGIN_DATA}',
      { path: '/plugins/demo', pluginId: 'demo@local' },
    );
    expect(out).toBe('root=/plugins/demo data=/data/demo@local');
  });

  it('leaves ${*_PLUGIN_DATA} literal and does NOT create a data dir when pluginId is absent (lazy)', () => {
    const out = substitutePluginVariables(
      'root=${QWEN_PLUGIN_ROOT} data=${QWEN_PLUGIN_DATA}',
      { path: '/plugins/demo' },
    );
    expect(out).toBe('root=/plugins/demo data=${QWEN_PLUGIN_DATA}');
    expect(getPluginDataDir).not.toHaveBeenCalled();
  });

  it('does NOT call getPluginDataDir when the DATA placeholder is absent (lazy)', () => {
    const out = substitutePluginVariables('root=${QWEN_PLUGIN_ROOT}', {
      path: '/plugins/demo',
      pluginId: 'demo@local',
    });
    expect(out).toBe('root=/plugins/demo');
    expect(getPluginDataDir).not.toHaveBeenCalled();
  });

  it('leaves unrelated placeholders untouched', () => {
    const out = substitutePluginVariables('keep ${SOMETHING_ELSE}', {
      path: '/plugins/demo',
      pluginId: 'demo@local',
    });
    expect(out).toBe('keep ${SOMETHING_ELSE}');
  });

  it('substitutes ${CLAUDE_SESSION_ID} when sessionId is supplied', () => {
    const out = substitutePluginVariables(
      'sid=${CLAUDE_SESSION_ID} root=${QWEN_PLUGIN_ROOT}',
      { path: '/plugins/demo', sessionId: 'sess-7' },
    );
    expect(out).toBe('sid=sess-7 root=/plugins/demo');
  });

  it('leaves ${CLAUDE_SESSION_ID} literal when sessionId is absent', () => {
    const out = substitutePluginVariables('sid=${CLAUDE_SESSION_ID}', {
      path: '/plugins/demo',
    });
    expect(out).toBe('sid=${CLAUDE_SESSION_ID}');
  });
});
