/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from 'vitest';
import {
  applyPluginConfigsToMcpServers,
  applyPluginConfigsToPlugins,
  applyPluginVariablesToMcpServers,
  getPluginConfigKey,
  type PluginConfigsRoot,
} from './pluginConfigSubstitution.js';
import type { LoadedPlugin } from '../types.js';
import type { MCPServerConfig } from '../../config/config.js';

function makePlugin(
  name: string,
  source: string,
  mcpServers?: Record<string, Partial<MCPServerConfig>>,
): LoadedPlugin {
  return {
    name,
    source,
    path: `/fake/${name}`,
    repository: source,
    enabled: true,
    manifest: { name, version: '1.0.0' },
    mcpServers: mcpServers as Record<string, MCPServerConfig> | undefined,
  } as unknown as LoadedPlugin;
}

describe('pluginConfigSubstitution', () => {
  describe('getPluginConfigKey', () => {
    it('returns bare name for local plugins', () => {
      const plugin = makePlugin('my-plugin', 'local');
      expect(getPluginConfigKey(plugin)).toBe('my-plugin');
    });

    it('returns bare name for flag plugins', () => {
      const plugin = makePlugin('my-plugin', 'flag');
      expect(getPluginConfigKey(plugin)).toBe('my-plugin');
    });

    it('returns bare name for builtin plugins', () => {
      const plugin = makePlugin('my-plugin', 'builtin');
      expect(getPluginConfigKey(plugin)).toBe('my-plugin');
    });

    it('returns name@marketplace for marketplace plugins', () => {
      const plugin = makePlugin('my-plugin', 'my-marketplace');
      expect(getPluginConfigKey(plugin)).toBe('my-plugin@my-marketplace');
    });
  });

  describe('applyPluginConfigsToMcpServers', () => {
    it('is a no-op when plugin has no mcpServers', () => {
      const plugin = makePlugin('p', 'local');
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { TOKEN: 'abc' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect(plugin.mcpServers).toBeUndefined();
    });

    it('is a no-op when pluginConfigs is undefined', () => {
      const plugin = makePlugin('p', 'local', {
        srv: { command: '${user_config.CMD}' } as Partial<MCPServerConfig>,
      });
      applyPluginConfigsToMcpServers(plugin, undefined);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '${user_config.CMD}',
      );
    });

    it('is a no-op when no matching config entry exists', () => {
      const plugin = makePlugin('p', 'local', {
        srv: { command: '${user_config.CMD}' } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        'other-plugin': { mcpServers: { srv: { CMD: 'run' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '${user_config.CMD}',
      );
    });

    it('substitutes ${user_config.*} in command field', () => {
      const plugin = makePlugin('p', 'local', {
        srv: { command: '${user_config.CMD}' } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { CMD: '/usr/bin/node' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).command).toBe('/usr/bin/node');
    });

    it('substitutes variables in hostEndpoint without renaming the field', () => {
      const plugin = makePlugin('p', 'local', {
        srv: Object.assign({ command: 'node' }, {
          hostEndpoint:
            'https://${user_config.HOST}/mcp/${user_config.CONNECTION}',
        }),
      });
      const configs: PluginConfigsRoot = {
        p: {
          mcpServers: {
            srv: { HOST: 'gateway.example', CONNECTION: 'one' },
          },
        },
      };

      applyPluginConfigsToMcpServers(plugin, configs, ['hostEndpoint']);

      expect(Reflect.get(plugin.mcpServers!['srv'], 'hostEndpoint')).toBe(
        'https://gateway.example/mcp/one',
      );
    });

    it('substitutes ${user_config.*} in args array', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: 'node',
          args: ['--token', '${user_config.TOKEN}', '--verbose'],
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { TOKEN: 'secret123' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.args).toEqual(['--token', 'secret123', '--verbose']);
    });

    it('substitutes ${user_config.*} in env values', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: 'node',
          env: {
            API_KEY: '${user_config.KEY}',
            PATH: '/usr/bin',
          },
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { KEY: 'my-api-key' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.env).toEqual({
        API_KEY: 'my-api-key',
        PATH: '/usr/bin',
      });
    });

    it('substitutes ${user_config.*} in url field', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          url: 'https://${user_config.HOST}/api',
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { HOST: 'example.com' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).url).toBe(
        'https://example.com/api',
      );
    });

    it('substitutes ${user_config.*} in httpUrl field', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          httpUrl: 'http://${user_config.HOST}:${user_config.PORT}/mcp',
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { HOST: 'localhost', PORT: 8080 } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).httpUrl).toBe(
        'http://localhost:8080/mcp',
      );
    });

    it('substitutes ${user_config.*} in headers values', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          url: 'https://api.example.com',
          headers: {
            Authorization: 'Bearer ${user_config.TOKEN}',
            'X-Custom': 'static-value',
          },
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { TOKEN: 'jwt-token-here' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.headers).toEqual({
        Authorization: 'Bearer jwt-token-here',
        'X-Custom': 'static-value',
      });
    });

    it('joins array config values with spaces for substitution', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: 'node',
          args: ['${user_config.FLAGS}'],
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { FLAGS: ['--verbose', '--debug'] } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.args).toEqual(['--verbose --debug']);
    });

    it('leaves original string when config key is missing (error tolerance)', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: '${user_config.MISSING_KEY}',
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { OTHER: 'value' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      // Should not crash, leaves original placeholder
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '${user_config.MISSING_KEY}',
      );
    });

    it('does not modify strings without ${user_config.*} placeholders', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: '/usr/bin/node',
          args: ['server.js', '--port=3000'],
          env: { NODE_ENV: 'production' },
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: { mcpServers: { srv: { FOO: 'bar' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.command).toBe('/usr/bin/node');
      expect(srv.args).toEqual(['server.js', '--port=3000']);
      expect(srv.env).toEqual({ NODE_ENV: 'production' });
    });

    it('supports fallback lookup by bare name for marketplace plugins', () => {
      const plugin = makePlugin('my-plugin', 'my-marketplace', {
        srv: {
          command: '${user_config.CMD}',
        } as Partial<MCPServerConfig>,
      });
      // Config is keyed by bare name (not canonical "my-plugin@my-marketplace")
      const configs: PluginConfigsRoot = {
        'my-plugin': { mcpServers: { srv: { CMD: '/opt/bin/tool' } } },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).command).toBe('/opt/bin/tool');
    });

    it('prefers canonical key over bare name fallback', () => {
      const plugin = makePlugin('my-plugin', 'my-marketplace', {
        srv: {
          command: '${user_config.CMD}',
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        'my-plugin@my-marketplace': {
          mcpServers: { srv: { CMD: '/canonical/path' } },
        },
        'my-plugin': {
          mcpServers: { srv: { CMD: '/fallback/path' } },
        },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '/canonical/path',
      );
    });

    it('handles multiple servers independently', () => {
      const plugin = makePlugin('p', 'local', {
        srv1: {
          command: '${user_config.CMD1}',
        } as Partial<MCPServerConfig>,
        srv2: {
          command: '${user_config.CMD2}',
        } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p: {
          mcpServers: {
            srv1: { CMD1: 'binary1' },
            srv2: { CMD2: 'binary2' },
          },
        },
      };
      applyPluginConfigsToMcpServers(plugin, configs);
      expect((plugin.mcpServers!['srv1'] as any).command).toBe('binary1');
      expect((plugin.mcpServers!['srv2'] as any).command).toBe('binary2');
    });
  });

  describe('applyPluginConfigsToPlugins', () => {
    it('is a no-op when pluginConfigs is undefined', () => {
      const plugin = makePlugin('p', 'local', {
        srv: { command: '${user_config.X}' } as Partial<MCPServerConfig>,
      });
      applyPluginConfigsToPlugins([plugin], undefined);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '${user_config.X}',
      );
    });

    it('applies substitution to all plugins in the list', () => {
      const p1 = makePlugin('p1', 'local', {
        srv: { command: '${user_config.CMD}' } as Partial<MCPServerConfig>,
      });
      const p2 = makePlugin('p2', 'local', {
        srv: { url: '${user_config.URL}' } as Partial<MCPServerConfig>,
      });
      const configs: PluginConfigsRoot = {
        p1: { mcpServers: { srv: { CMD: '/bin/tool' } } },
        p2: { mcpServers: { srv: { URL: 'https://api.test' } } },
      };
      applyPluginConfigsToPlugins([p1, p2], configs);
      expect((p1.mcpServers!['srv'] as any).command).toBe('/bin/tool');
      expect((p2.mcpServers!['srv'] as any).url).toBe('https://api.test');
    });

    it('substitutes plugin path vars even when pluginConfigs is undefined', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: '${QWEN_PLUGIN_ROOT}/server.js',
        } as Partial<MCPServerConfig>,
      });
      // No pluginConfigs at all — user_config substitution is skipped, but
      // plugin path variables must still be resolved (regression guard).
      applyPluginConfigsToPlugins([plugin], undefined);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '/fake/p/server.js',
      );
    });
  });

  describe('applyPluginVariablesToMcpServers', () => {
    it('is a no-op when plugin has no mcpServers', () => {
      const plugin = makePlugin('p', 'local');
      applyPluginVariablesToMcpServers(plugin);
      expect(plugin.mcpServers).toBeUndefined();
    });

    it('substitutes ${QWEN_PLUGIN_ROOT} across all string fields', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: '${QWEN_PLUGIN_ROOT}/bin/server',
          args: ['--config', '${QWEN_PLUGIN_ROOT}/cfg.json'],
          env: { ROOT: '${QWEN_PLUGIN_ROOT}', STATIC: 'x' },
          url: 'file://${QWEN_PLUGIN_ROOT}/sock',
          httpUrl: 'http://localhost/${QWEN_PLUGIN_ROOT}',
          headers: { 'X-Root': '${QWEN_PLUGIN_ROOT}', 'X-Static': 'y' },
        } as Partial<MCPServerConfig>,
      });
      applyPluginVariablesToMcpServers(plugin);
      const srv = plugin.mcpServers!['srv'] as any;
      expect(srv.command).toBe('/fake/p/bin/server');
      expect(srv.args).toEqual(['--config', '/fake/p/cfg.json']);
      expect(srv.env).toEqual({ ROOT: '/fake/p', STATIC: 'x' });
      expect(srv.url).toBe('file:///fake/p/sock');
      expect(srv.httpUrl).toBe('http://localhost//fake/p');
      expect(srv.headers).toEqual({ 'X-Root': '/fake/p', 'X-Static': 'y' });
    });

    it('substitutes ${CLAUDE_PLUGIN_ROOT} alias for upstream plugins', () => {
      const plugin = makePlugin('p', 'local', {
        srv: {
          command: '${CLAUDE_PLUGIN_ROOT}/server.js',
        } as Partial<MCPServerConfig>,
      });
      applyPluginVariablesToMcpServers(plugin);
      expect((plugin.mcpServers!['srv'] as any).command).toBe(
        '/fake/p/server.js',
      );
    });
  });
});
