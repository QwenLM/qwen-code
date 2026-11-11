/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { describe, expect, it } from 'vitest';
import {
  Config,
  MCPServerConfig,
  type ConfigParameters,
} from '../config/config.js';
import { stripScope, stripScopeFromServer } from './mcpServerScope.js';

const baseParams: ConfigParameters = {
  loadedSettings: createEmptyLoadedSettings(),
  cwd: '/tmp',
  embeddingModel: 'embedding',
  targetDir: '/tmp',
  debugMode: false,
  question: '',
  userMemory: '',
  sessionId: 'mcp-source-test',
  model: 'qwen-max',
};

describe('Config MCP source buckets', () => {
  it('allows settings-backed sources by default and can disable them', () => {
    expect(new Config(baseParams).getMcpSettingsSourcesEnabled()).toBe(true);
    expect(
      new Config({
        ...baseParams,
        mcpSettingsSourcesEnabled: false,
      }).getMcpSettingsSourcesEnabled(),
    ).toBe(false);
  });

  it('getMcpServers returns the merged effective view (disk ∪ dynamic, dynamic wins)', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: {
        'on-disk': new MCPServerConfig('disk-cmd'),
        shared: new MCPServerConfig('disk-shared'),
      },
    });

    config.setDynamicMcpServers({
      injected: new MCPServerConfig('dynamic-cmd'),
      shared: new MCPServerConfig('dynamic-shared'),
    });

    const merged = config.getMcpServers();
    expect(Object.keys(merged ?? {}).sort()).toEqual([
      'injected',
      'on-disk',
      'shared',
    ]);
    expect(merged?.['shared'].command).toBe('dynamic-shared');
    expect(merged?.['injected'].scope).toBe('dynamic');
    expect(merged?.['on-disk'].scope).toBeUndefined();
  });

  it('preserves hostEndpoint across disk and dynamic source tagging', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: {
        disk: Object.assign({
          command: 'disk-command',
        }, {
          hostEndpoint: 'https://gateway.example/mcp/disk',
        }),
      },
    });
    config.setDynamicMcpServers({
      dynamic: Object.assign({
        url: 'https://provider.example/mcp',
      }, {
        hostEndpoint: 'https://gateway.example/mcp/dynamic',
      }),
    });

    expect(Reflect.get(config.getMcpServers()!['disk'], 'hostEndpoint')).toBe(
      'https://gateway.example/mcp/disk',
    );
    expect(config.getMcpServers()?.['dynamic']).toMatchObject({
      hostEndpoint: 'https://gateway.example/mcp/dynamic',
      scope: 'dynamic',
    });
    expect(stripScope(config.getDynamicMcpServers())['dynamic']).toEqual({
      url: 'https://provider.example/mcp',
      hostEndpoint: 'https://gateway.example/mcp/dynamic',
    });
  });

  it('getDiskMcpServers / getDynamicMcpServers are independently addressable', () => {
    const config = new Config({
      ...baseParams,
      mcpServers: { disk: new MCPServerConfig('disk-cmd') },
    });
    config.setDynamicMcpServers({ dyn: new MCPServerConfig('dyn-cmd') });

    expect(Object.keys(config.getDiskMcpServers() ?? {})).toEqual(['disk']);
    expect(Object.keys(config.getDynamicMcpServers())).toEqual(['dyn']);
  });

  it('setDiskMcpServers leaves the dynamic bucket untouched', () => {
    const config = new Config(baseParams);
    config.setDynamicMcpServers({ keepme: new MCPServerConfig('keep') });

    config.setDiskMcpServers({ ondisk: new MCPServerConfig('odisk') });
    expect(Object.keys(config.getDynamicMcpServers())).toEqual(['keepme']);
    expect(Object.keys(config.getDiskMcpServers() ?? {})).toEqual(['ondisk']);
  });

  it('setDynamicMcpServers stamps scope="dynamic" on every entry', () => {
    const config = new Config(baseParams);
    config.setDynamicMcpServers({
      a: new MCPServerConfig('a'),
      b: new MCPServerConfig('b'),
    });
    const dyn = config.getDynamicMcpServers();
    expect(dyn['a'].scope).toBe('dynamic');
    expect(dyn['b'].scope).toBe('dynamic');
  });

  it('returns undefined from getMcpServers when both buckets are empty', () => {
    const config = new Config(baseParams);
    expect(config.getMcpServers()).toBeUndefined();
  });
});

describe('stripScope', () => {
  it('removes the scope field without mutating the input or other fields', () => {
    const tagged = {
      a: { command: 'a', scope: 'project' } as MCPServerConfig,
      b: { command: 'b', scope: 'dynamic' } as MCPServerConfig,
    };

    const stripped = stripScope(tagged);
    expect(stripped['a']).toEqual({ command: 'a' });
    expect(stripped['b']).toEqual({ command: 'b' });
    // input untouched
    expect(tagged['a'].scope).toBe('project');
  });

  it('stripScopeFromServer is a no-op when scope is absent', () => {
    const cfg = { command: 'a' } as MCPServerConfig;
    expect(stripScopeFromServer(cfg)).toBe(cfg);
  });
});
