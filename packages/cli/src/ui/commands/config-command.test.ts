/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { configCommand } from './config-command.js';
import { CommandKind } from './types.js';
import type { CommandContext } from './types.js';

function createMockContext(mergedSettings: Record<string, unknown> = {}) {
  const setValuesMock = vi.fn();
  const mockSettings = {
    merged: mergedSettings,
    setValues: setValuesMock,
  };

  const ctx = {
    services: {
      settings: mockSettings,
      config: null,
      logger: null,
    },
  } as unknown as CommandContext;

  return { ctx, setValuesMock };
}

describe('configCommand', () => {
  it('is a built-in command available in all execution modes', () => {
    expect(configCommand.name).toBe('config');
    expect(configCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(configCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('has correct metadata', () => {
    expect(configCommand.argumentHint).toBe('<key>[=<value>] or --help');
    expect(configCommand.description).toBeTruthy();
  });

  describe('set boolean value', () => {
    it('sets a boolean setting to true', async () => {
      const { ctx, setValuesMock } = createMockContext({
        general: { vimMode: false },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode=true');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.vimMode'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: true },
      ]);
    });

    it('sets a boolean setting to false', async () => {
      const { ctx, setValuesMock } = createMockContext({
        general: { vimMode: true },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode=false');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('false'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: false },
      ]);
    });

    it('accepts case-insensitive boolean values', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMode=True');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.vimMode'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: true },
      ]);
    });

    it('accepts 1 and 0 as boolean values', async () => {
      const { ctx, setValuesMock } = createMockContext({});

      const result1 = await configCommand.action!(ctx, 'general.vimMode=1');
      expect(result1).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.vimMode'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: true },
      ]);

      const result0 = await configCommand.action!(ctx, 'general.vimMode=0');
      expect(result0).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.vimMode'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: false },
      ]);
    });
  });

  describe('toggle boolean', () => {
    it('toggles a boolean from false to true', async () => {
      const { ctx, setValuesMock } = createMockContext({
        general: { vimMode: false },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('true'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: true },
      ]);
    });

    it('toggles a boolean from true to false', async () => {
      const { ctx, setValuesMock } = createMockContext({
        general: { vimMode: true },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('false'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.vimMode', value: false },
      ]);
    });

    it('toggles undefined boolean to true', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('true'),
      });
    });

    it.each(['ui.accessibility.screenReader', 'security.auth.useExternal'])(
      'enables an unset default-off setting: %s',
      async (key) => {
        const { ctx, setValuesMock } = createMockContext({});
        const result = await configCommand.action!(ctx, key);

        expect(result).toEqual({
          type: 'message',
          messageType: 'info',
          content: expect.stringContaining('true'),
        });
        expect(setValuesMock).toHaveBeenCalledWith([
          { scope: 'User', key, value: true },
        ]);
      },
    );

    it('turns the unset unified agent loop setting on', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      await configCommand.action!(ctx, 'experimental.unifiedAgentLoop');

      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'experimental.unifiedAgentLoop', value: true },
      ]);
    });

    it('turns an unset tri-state web search setting off', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.webSearch.enabled',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('false'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        {
          scope: 'User',
          key: 'tools.webSearch.enabled',
          value: false,
        },
      ]);
    });
  });

  describe('invalid boolean value', () => {
    it('returns error for invalid boolean value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMode=yes');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid boolean'),
      });
    });
  });

  describe('enum settings', () => {
    it('sets a valid enum value', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=auto',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('auto'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'tools.approvalMode', value: 'auto' },
      ]);
    });

    it('returns error for invalid enum value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=invalid_mode',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid enum value'),
      });
    });

    it('shows current value when toggling enum', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'tools.approvalMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('tools.approvalMode ='),
      });
    });
  });

  describe('string settings', () => {
    it('sets a string value', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.preferredEditor=vim',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('vim'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'general.preferredEditor', value: 'vim' },
      ]);
    });

    it('shows current value when toggling string', async () => {
      const { ctx } = createMockContext({
        general: { preferredEditor: 'vscode' },
      });
      const result = await configCommand.action!(
        ctx,
        'general.preferredEditor',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.preferredEditor = vscode'),
      });
    });
  });

  describe('number settings', () => {
    it('sets a number value', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=10',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('10'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        {
          scope: 'User',
          key: 'general.sessionRecapAwayThresholdMinutes',
          value: 10,
        },
      ]);
    });

    it('returns error for invalid number value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=abc',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid number'),
      });
    });

    it('returns error for empty number value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid number'),
      });
    });

    it('returns error for Infinity', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=Infinity',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid number'),
      });
    });

    it('shows current value when toggling number', async () => {
      const { ctx } = createMockContext({
        general: { sessionRecapAwayThresholdMinutes: 30 },
      });
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining(
          'general.sessionRecapAwayThresholdMinutes = 30',
        ),
      });
    });
  });

  describe('array/object settings', () => {
    it('returns error for object settings', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'mcpServers={"test":{}}');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('settings.json'),
      });
    });
  });

  describe('unknown keys', () => {
    it('returns error for unknown key', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'nonexistent.key=value');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Unknown setting key'),
      });
    });

    it('suggests closest key for typo', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMod=true');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Did you mean'),
      });
    });
  });

  describe('--help', () => {
    it('lists all settings with --help', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '--help');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });

    it('lists all settings with -h', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '-h');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });

    it('lists all settings when no args provided', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });

    it('masks sensitive values in listing', async () => {
      const { ctx } = createMockContext({
        proxy: 'http://my-secret-proxy:8080',
      });
      const result = await configCommand.action!(ctx, '--help');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.not.stringContaining('my-secret-proxy'),
      });
    });
  });

  describe('restart warning', () => {
    it('shows restart warning for settings that require restart', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'proxy=http://localhost:8080',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('requires a restart'),
      });
    });

    it('shows restart warning for Goal cadence settings', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(ctx, 'model.goalMaxTurns=20');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('requires a restart'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'model.goalMaxTurns', value: 20 },
      ]);
    });
  });

  describe('security-sensitive settings', () => {
    it('shows sensitive warning when setting proxy', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'proxy=http://localhost:8080',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Security-sensitive'),
      });
    });

    it('masks sensitive value when getting proxy without =', async () => {
      const { ctx } = createMockContext({
        proxy: 'http://secret-proxy:8080',
      });
      const result = await configCommand.action!(ctx, 'proxy');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.not.stringContaining('secret-proxy'),
      });
    });

    it('masks sensitive values nested in an object read by its parent key', async () => {
      const { ctx } = createMockContext({
        security: {
          auth: {
            selectedType: 'openai',
            apiKey: 'sk-demo-1234567890',
            baseUrl: 'https://llm.example.com/v1',
          },
        },
      });

      expect(await configCommand.action!(ctx, 'security.auth')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'security.auth = {"selectedType":"openai","apiKey":"sk-d****","baseUrl":"http****"}',
      });
      expect(await configCommand.action!(ctx, 'security')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'security = {"auth":{"selectedType":"openai","apiKey":"sk-d****","baseUrl":"http****"}}',
      });
    });

    it('masks every value in nested env and header maps', async () => {
      const { ctx } = createMockContext({
        mcpServers: {
          gh: {
            command: 'npx',
            env: { GITHUB_TOKEN: 'ghp_liveSecret' },
            headers: {
              Authorization: 'Bearer sk-live-123',
              'X-Auth-Token': 'tok_live',
            },
          },
        },
      });

      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"gh":{"command":"npx","env":{"GITHUB_TOKEN":"ghp_****"},"headers":{"Authorization":"Bear****","X-Auth-Token":"tok_****"}}}',
      });
    });

    it('keeps a map entry whose name looks sensitive and shows *Env variable names', async () => {
      const { ctx } = createMockContext({
        mcpServers: {
          'corp-proxy': {
            command: 'npx',
            credentialEnv: 'MEM0_API_KEY',
            apiKey: 'sk-demo-1234567890',
          },
        },
      });

      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"corp-proxy":{"command":"npx","credentialEnv":"MEM0_API_KEY","apiKey":"sk-d****"}}',
      });
    });

    it('masks every value of the top-level env setting', async () => {
      const { ctx } = createMockContext({
        env: {
          GITHUB_TOKEN: 'ghp_liveSecret',
          NPM_TOKEN: 'npm_abc',
          OPENAI_API_KEY: '',
        },
      });

      expect(await configCommand.action!(ctx, 'env')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'env = {"GITHUB_TOKEN":"ghp_****","NPM_TOKEN":"npm_****","OPENAI_API_KEY":"(empty)"}',
      });
    });

    it('masks every leaf beneath a sensitive-named object or array', async () => {
      const { ctx } = createMockContext({
        mcpServers: {
          db: {
            command: 'npx',
            credentials: {
              user: 'admin',
              db: { value: 'hunter2-super-secret' },
            },
            apiKeys: ['sk-live-aaaa', 'sk-live-bbbb'],
          },
        },
      });

      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"db":{"command":"npx","credentials":{"user":"admi****","db":{"value":"hunt****"}},"apiKeys":["sk-l****","sk-l****"]}}',
      });
    });

    it('keeps null, number and boolean leaves under a masked key', async () => {
      const { ctx } = createMockContext({
        security: { auth: { selectedType: 'openai', apiKey: null } },
        mcpServers: {
          db: {
            command: 'npx',
            credentials: {
              user: 'admin',
              retries: 3,
              enabled: true,
              missing: null,
            },
          },
        },
      });

      expect(await configCommand.action!(ctx, 'security')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'security = {"auth":{"selectedType":"openai","apiKey":null}}',
      });
      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"db":{"command":"npx","credentials":{"user":"admi****","retries":3,"enabled":true,"missing":null}}}',
      });
    });

    it('keeps user-named entries of other free-form maps readable', async () => {
      const { ctx } = createMockContext({
        providerProtocol: { 'corp-proxy': 'openai' },
        pluginConfigs: {
          'secret-scan': { toolDialect: 'claude', options: { level: 'high' } },
        },
        ui: { customThemes: { 'Secret Garden': { background: '#000000' } } },
      });

      expect(await configCommand.action!(ctx, 'providerProtocol')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'providerProtocol = {"corp-proxy":"openai"}',
      });
      expect(await configCommand.action!(ctx, 'pluginConfigs')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'pluginConfigs = {"secret-scan":{"toolDialect":"claude","options":{"level":"high"}}}',
      });
      expect(await configCommand.action!(ctx, 'ui.customThemes')).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'ui.customThemes = {"Secret Garden":{"background":"#000000"}}',
      });
    });

    it('masks customHeaders, scalar and empty credential map values', async () => {
      const { ctx } = createMockContext({
        modelProviders: {
          gw: [
            {
              generationConfig: {
                customHeaders: { Authorization: 'Bearer sk-live-123' },
              },
            },
          ],
        },
        mcpServers: {
          gh: { command: 'npx', env: 'GITHUB_TOKEN' },
          gl: { command: 'npx', env: { OPENAI_API_KEY: '' } },
        },
      });

      expect(await configCommand.action!(ctx, 'modelProviders')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'modelProviders = {"gw":[{"generationConfig":{"customHeaders":{"Authorization":"Bear****"}}}]}',
      });
      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"gh":{"command":"npx","env":"GITH****"},"gl":{"command":"npx","env":{"OPENAI_API_KEY":"(empty)"}}}',
      });
    });

    it('masks channel webhook URLs and AES keys but keeps their type', async () => {
      const { ctx } = createMockContext({
        channels: {
          'team-notices': {
            type: 'dingtalk-webhook',
            webhookUrl:
              'https://oapi.dingtalk.com/robot/send?access_token=live-secret',
          },
          wecom: { type: 'wecom', encodingAESKey: 'AAAAbbbbCCCC' },
        },
      });

      expect(await configCommand.action!(ctx, 'channels')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'channels = {"team-notices":{"type":"dingtalk-webhook","webhookUrl":"http****"},"wecom":{"type":"wecom","encodingAESKey":"AAAA****"}}',
      });
    });

    it('keeps an MCP server named headers readable but masks its headers field', async () => {
      const { ctx } = createMockContext({
        mcpServers: {
          headers: { command: 'npx', url: 'http://localhost:3000' },
          gh: {
            command: 'npx',
            headers: { Authorization: 'Bearer sk-live-123' },
          },
        },
      });

      expect(await configCommand.action!(ctx, 'mcpServers')).toEqual({
        type: 'message',
        messageType: 'info',
        content:
          'mcpServers = {"headers":{"command":"npx","url":"http://localhost:3000"},"gh":{"command":"npx","headers":{"Authorization":"Bear****"}}}',
      });
    });

    it('shows an *Env variable name read directly', async () => {
      const { ctx } = createMockContext({
        omni: { delivery: { upload: { apiKeyEnv: 'DASHSCOPE_API_KEY' } } },
      });

      expect(
        await configCommand.action!(ctx, 'omni.delivery.upload.apiKeyEnv'),
      ).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'omni.delivery.upload.apiKeyEnv = DASHSCOPE_API_KEY',
      });
    });

    it('masks sensitive value in write confirmation message', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'proxy=http://secret-proxy:8080',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.not.stringContaining('secret-proxy'),
      });
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('http****'),
      });
    });
  });

  describe('whitespace handling', () => {
    it('trims whitespace from value after = sign', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode= auto ',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('auto'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'tools.approvalMode', value: 'auto' },
      ]);
    });
  });

  describe('security blocklist', () => {
    it('blocks setting tools.approvalMode to yolo', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=yolo',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('blocked'),
      });
      expect(setValuesMock).not.toHaveBeenCalled();
    });

    it('allows setting tools.approvalMode to non-yolo values', async () => {
      const { ctx, setValuesMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=auto',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('auto'),
      });
      expect(setValuesMock).toHaveBeenCalledWith([
        { scope: 'User', key: 'tools.approvalMode', value: 'auto' },
      ]);
    });
  });

  describe('setValue error handling', () => {
    it('returns error message when setValues throws', async () => {
      const { ctx } = createMockContext({});
      const settings = ctx.services.settings as unknown as {
        setValues: ReturnType<typeof vi.fn>;
      };
      settings.setValues.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await configCommand.action!(ctx, 'general.vimMode=true');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Failed to set'),
      });
    });
  });

  describe('completion', () => {
    it('provides completions for partial key', async () => {
      const { ctx } = createMockContext({});
      const completions = await configCommand.completion!(ctx, 'general.vim');

      expect(completions).toBeTruthy();
      expect(completions!.length).toBeGreaterThan(0);
      expect(
        completions!.some((c) =>
          typeof c === 'string'
            ? c.includes('vimMode')
            : c.value.includes('vimMode'),
        ),
      ).toBe(true);
    });

    it('returns null when completing after = sign', async () => {
      const { ctx } = createMockContext({});
      const completions = await configCommand.completion!(
        ctx,
        'general.vimMode=',
      );

      expect(completions).toBeNull();
    });

    it('excludes non-settable types from completions', async () => {
      const { ctx } = createMockContext({});
      const completions = await configCommand.completion!(ctx, 'mcp');

      if (completions) {
        const hasObjectOrArray = completions.some((c) => {
          const value = typeof c === 'string' ? c : c.value;
          return value === 'mcpServers';
        });
        expect(hasObjectOrArray).toBe(false);
      }
    });
  });
});
