/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extensionConsentString, requestConsentOrFail } from './consent.js';
import type { ExtensionConfig } from '@qwen-code/qwen-code-core';

vi.mock('../../i18n/index.js', () => ({
  t: vi.fn((str: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (acc, [key, value]) => acc.replace(`{{${key}}}`, value),
        str,
      );
    }
    return str;
  }),
}));

describe('extensionConsentString', () => {
  it('should include extension name', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    const result = extensionConsentString(config);

    expect(result).toContain('Installing extension "test-extension".');
  });

  it('should include warning message', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    const result = extensionConsentString(config);

    expect(result).toContain('Extensions may introduce unexpected behavior');
  });

  it('should include MCP servers when present', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
      mcpServers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        },
      },
    };

    const result = extensionConsentString(config);

    expect(result).toContain(
      'This extension will run the following MCP servers',
    );
    expect(result).toContain('test-server');
    expect(result).toContain('local');
    expect(result).toContain('node server.js');
  });

  it('should include remote MCP servers', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
      mcpServers: {
        'remote-server': {
          httpUrl: 'https://example.com/mcp',
        },
      },
    };

    const result = extensionConsentString(config);

    expect(result).toContain('remote');
    expect(result).toContain('https://example.com/mcp');
  });

  it('should include commands when present', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    const result = extensionConsentString(config, ['command1', 'command2']);

    expect(result).toContain('This extension will add the following commands');
    expect(result).toContain('command1, command2');
  });

  it('should include context file name when present (string)', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
      contextFileName: 'CUSTOM.md',
    };

    const result = extensionConsentString(config);

    expect(result).toContain('CUSTOM.md');
  });

  it('should include context file name when present (array)', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
      contextFileName: ['FILE1.md', 'FILE2.md'],
    };

    const result = extensionConsentString(config);

    expect(result).toContain('FILE1.md, FILE2.md');
  });

  it('should include skills when present', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    const result = extensionConsentString(
      config,
      [],
      [
        {
          name: 'skill1',
          description: 'Skill 1 description',
          level: 'extension',
          filePath: '/test/skill1',
          body: 'skill body',
        },
        {
          name: 'skill2',
          description: 'Skill 2 description',
          level: 'extension',
          filePath: '/test/skill2',
          body: 'skill body',
        },
      ],
    );

    expect(result).toContain(
      'This extension will install the following skills',
    );
    expect(result).toContain('skill1');
    expect(result).toContain('Skill 1 description');
  });

  it('should include subagents when present', () => {
    const config: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    const result = extensionConsentString(
      config,
      [],
      [],
      [
        {
          name: 'agent1',
          description: 'Agent 1 description',
          systemPrompt: 'You are agent1',
          level: 'extension',
        },
      ],
    );

    expect(result).toContain(
      'This extension will install the following subagents',
    );
    expect(result).toContain('agent1');
    expect(result).toContain('Agent 1 description');
  });
});

describe('requestConsentOrFail', () => {
  let mockRequestConsent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequestConsent = vi.fn();
    vi.clearAllMocks();
  });

  it('should do nothing when options is undefined', async () => {
    await requestConsentOrFail(mockRequestConsent, undefined);

    expect(mockRequestConsent).not.toHaveBeenCalled();
  });

  it('should request consent for new extension', async () => {
    mockRequestConsent.mockResolvedValueOnce(true);

    await requestConsentOrFail(mockRequestConsent, {
      extensionConfig: { name: 'test-extension', version: '1.0.0' },
    });

    expect(mockRequestConsent).toHaveBeenCalled();
  });

  it('should throw error when user declines consent', async () => {
    mockRequestConsent.mockResolvedValueOnce(false);

    await expect(
      requestConsentOrFail(mockRequestConsent, {
        extensionConfig: { name: 'test-extension', version: '1.0.0' },
      }),
    ).rejects.toThrow('Installation cancelled for "test-extension".');
  });

  it('should skip consent when consent string is unchanged', async () => {
    const extensionConfig: ExtensionConfig = {
      name: 'test-extension',
      version: '1.0.0',
    };

    await requestConsentOrFail(mockRequestConsent, {
      extensionConfig,
      previousExtensionConfig: extensionConfig,
    });

    expect(mockRequestConsent).not.toHaveBeenCalled();
  });

  it('should request consent when commands change', async () => {
    mockRequestConsent.mockResolvedValueOnce(true);

    await requestConsentOrFail(mockRequestConsent, {
      extensionConfig: { name: 'test-extension', version: '1.0.0' },
      commands: ['command1'],
      previousExtensionConfig: { name: 'test-extension', version: '1.0.0' },
      previousCommands: [],
    });

    expect(mockRequestConsent).toHaveBeenCalled();
  });
});
