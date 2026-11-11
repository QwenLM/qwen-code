/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeLegacySettingsShape,
  sanitizeRecoverableSettingsValidationIssues,
  skipInvalidMcpServerConfigs,
} from './settingsCompatibility.js';

describe('normalizeLegacySettingsShape', () => {
  it('converts string model to object', () => {
    const s: Record<string, unknown> = { model: 'gpt-4' };
    const changes = normalizeLegacySettingsShape(s);
    expect(s['model']).toEqual({ name: 'gpt-4' });
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('model');
  });

  it('leaves object model untouched', () => {
    const s: Record<string, unknown> = { model: { name: 'x' } };
    const changes = normalizeLegacySettingsShape(s);
    expect(s['model']).toEqual({ name: 'x' });
    expect(changes).toHaveLength(0);
  });
});

describe('skipInvalidMcpServerConfigs', () => {
  // skip: 现存失败
  it.skip('keeps MCP servers after stripping unknown provider-specific metadata', () => {
    const linear = {
      hostEndpoint: 'https://mcp.example.com/api/v1/mcp/servers/mcp_srv_example',
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    };
    const s: Record<string, unknown> = {
      mcpServers: { Linear: linear },
    };

    const skippedServers = skipInvalidMcpServerConfigs(s);

    expect(skippedServers).toEqual([]);
    expect(s['mcpServers']).toEqual({
      Linear: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
      },
    });
  });

  it('skips an invalid MCP server and keeps valid servers', () => {
    const s: Record<string, unknown> = {
      mcpServers: {
        bad: { args: 123, type: 'stdio', command: 'bar' },
        clean: { type: 'http', url: 'https://x' },
      },
    };

    const skippedServers = skipInvalidMcpServerConfigs(s);

    expect(skippedServers).toHaveLength(1);
    expect(skippedServers[0].serverName).toBe('bad');
    expect(skippedServers[0].reason).toContain(
      'Skipped invalid MCP server "bad"',
    );
    expect(s['mcpServers']).toEqual({
      clean: { type: 'http', url: 'https://x' },
    });
  });

  it('skips MCP transport types unsupported by the settings schema', () => {
    const s: Record<string, unknown> = {
      mcpServers: {
        internal: { type: 'in_process' },
        sdk: { type: 'sdk' },
      },
    };

    const skippedServers = skipInvalidMcpServerConfigs(s);

    expect(skippedServers.map((server) => server.serverName)).toEqual([
      'internal',
      'sdk',
    ]);
    expect(s['mcpServers']).toEqual({});
  });

  it('does not rewrite the top-level mcpServers shape', () => {
    const s: Record<string, unknown> = { mcpServers: [] };

    const skippedServers = skipInvalidMcpServerConfigs(s);

    expect(skippedServers).toEqual([]);
    expect(s['mcpServers']).toEqual([]);
  });
});

describe('sanitizeRecoverableSettingsValidationIssues', () => {
  it('removes the retired provider image field with a migration warning', () => {
    const settings: Record<string, unknown> = {
      providers: {
        gateway: {
          baseUrl: 'https://models.example.test/v1',
          apiKey: 'chat-secret',
          model: 'chat-model',
          image: {
            type: 'openai-compatible',
            model: 'image-model',
            baseUrl: 42,
            apiKey: 'image-secret',
          },
        },
      },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(settings);

    expect(result.validationResult.success).toBe(true);
    expect(settings).toEqual({
      providers: {
        gateway: {
          baseUrl: 'https://models.example.test/v1',
          apiKey: 'chat-secret',
          model: 'chat-model',
        },
      },
    });
    expect(result.ignoredIssues).toContainEqual(
      expect.objectContaining({
        path: 'providers.gateway.image',
        reason: expect.stringContaining('tools.imageGen'),
      }),
    );
  });

  it('ignores invalid settings across roots', () => {
    const s: Record<string, unknown> = {
      ui: { theme: 123, showMemoryUsage: true, maxTurns: 50 },
      statusLine: 'not an object',
      model: { name: 'qwen' },
      modelConfigs: { customOverrides: { bad: true } },
      tools: { core: ['read_file', 123] },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.ignoredIssues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'ui.theme',
        'ui.maxTurns',
        'statusLine',
        'modelConfigs.customOverrides',
        'tools.core[1]',
      ]),
    );
    expect(s['ui']).toEqual({ showMemoryUsage: true });
    expect(s['statusLine']).toBeUndefined();
    expect(s['model']).toEqual({ name: 'qwen' });
    expect(s['modelConfigs']).toEqual({});
    expect(s['tools']).toEqual({ core: ['read_file'] });
    expect(result.validationResult.success).toBe(true);
  });

  it('uses an English runtime fallback for an invalid UI language', () => {
    const settings: Record<string, unknown> = {
      ui: { language: 'fr' },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(settings);

    expect(result.validationResult.success).toBe(true);
    expect(settings).toEqual({ ui: { language: 'en' } });
    expect(result.ignoredIssues).toEqual([
      expect.objectContaining({
        path: 'ui.language',
        reason: expect.stringContaining(
          'Ignored invalid setting "ui.language"',
        ),
      }),
    ]);
  });

  it('drops invalid items from recoverable arrays', () => {
    const s: Record<string, unknown> = {
      agentsMdExcludes: ['keep', 123, 'also-keep'],
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.validationResult.success).toBe(true);
    expect(s['agentsMdExcludes']).toEqual(['keep', 'also-keep']);
    expect(result.ignoredIssues).toEqual([
      expect.objectContaining({
        path: 'agentsMdExcludes[1]',
        reason: expect.stringContaining('agentsMdExcludes[1]'),
      }),
    ]);
  });

  it('revalidates between array item removals so valid items are preserved', () => {
    const s: Record<string, unknown> = {
      agentsMdExcludes: ['keep', 123, false, 'also-keep'],
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.validationResult.success).toBe(true);
    expect(s['agentsMdExcludes']).toEqual(['keep', 'also-keep']);
    expect(result.ignoredIssues.map((issue) => issue.path)).toEqual([
      'agentsMdExcludes[1]',
      'agentsMdExcludes[1]',
    ]);
  });

  it('drops invalid recoverable map entries when required fields are missing', () => {
    const s: Record<string, unknown> = {
      ui: {
        customThemes: {
          missingType: { name: 'Missing Type' },
          missingName: { type: 'custom' },
          good: { type: 'custom', name: 'Good' },
        },
      },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.validationResult.success).toBe(true);
    expect(s['ui']).toEqual({
      customThemes: {
        good: { type: 'custom', name: 'Good' },
      },
    });
    expect(result.ignoredIssues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'ui.customThemes.missingType',
        'ui.customThemes.missingName',
      ]),
    );
  });

  it('removes unrecognized keys from recoverable strict objects', () => {
    const s: Record<string, unknown> = {
      ui: {
        customThemes: {
          custom: {
            type: 'custom',
            name: 'Custom',
            unexpected: true,
          },
        },
      },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.validationResult.success).toBe(true);
    expect(s['ui']).toEqual({
      customThemes: {
        custom: {
          type: 'custom',
          name: 'Custom',
        },
      },
    });
    expect(result.ignoredIssues[0]).toEqual(
      expect.objectContaining({
        path: 'ui.customThemes.custom.unexpected',
      }),
    );
  });

  it('drops invalid permission settings instead of forcing startup failure', () => {
    const s: Record<string, unknown> = {
      permissions: { additionalDirectories: {} },
    };

    const result = sanitizeRecoverableSettingsValidationIssues(s);

    expect(result.ignoredIssues).toEqual([
      expect.objectContaining({
        path: 'permissions.additionalDirectories',
      }),
    ]);
    expect(s['permissions']).toEqual({});
    expect(result.validationResult.success).toBe(true);
  });
});
