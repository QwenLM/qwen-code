/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import stripJsonComments from 'strip-json-comments';
import { registerPlugin } from '../commands/channel/channel-registry.js';
import { resetHomeEnvBootstrapForTesting } from '../config/settings.js';
import { WorkspaceChannelSettingsStore } from './channel-settings-store.js';

describe('WorkspaceChannelSettingsStore', () => {
  let testRoot: string;
  let workspace: string;
  let settingsPath: string;
  let originalQwenHome: string | undefined;

  const writeWorkspaceSettings = (contents: string) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, contents);
  };

  const readWorkspaceSettings = (): Record<string, unknown> =>
    JSON.parse(
      stripJsonComments(fs.readFileSync(settingsPath, 'utf8')),
    ) as Record<string, unknown>;

  beforeAll(() => {
    registerPlugin({
      channelType: 'management-validation-test',
      displayName: 'Management validation test',
      management: {
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
            envResolvable: true,
          },
          {
            key: 'clientSecret',
            label: 'Client Secret',
            kind: 'secret',
            required: true,
            envResolvable: true,
          },
          {
            key: 'optionalSecret',
            label: 'Optional Secret',
            kind: 'secret',
          },
          { key: 'enabled', label: 'Enabled', kind: 'boolean' },
          { key: 'retries', label: 'Retries', kind: 'number' },
          {
            key: 'mode',
            label: 'Mode',
            kind: 'enum',
            options: [
              { value: 'safe', label: 'Safe' },
              { value: 'fast', label: 'Fast' },
            ],
          },
          { key: 'literalOnly', label: 'Literal only', kind: 'string' },
        ],
      },
      createChannel() {
        throw new Error('not used');
      },
    });
  });

  beforeEach(() => {
    originalQwenHome = process.env['QWEN_HOME'];
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-settings-'));
    workspace = path.join(testRoot, 'workspace');
    settingsPath = path.join(workspace, '.qwen', 'settings.json');
    process.env['QWEN_HOME'] = path.join(testRoot, 'home');
    resetHomeEnvBootstrapForTesting();
    writeWorkspaceSettings(`{
  // Keep this comment and unrelated setting.
  "$version": 4,
  "general": { "vimMode": true },
  "channels": {
    "bot": {
      "type": "management-validation-test",
      "clientId": "client-id",
      "clientSecret": "$BOT_TOKEN",
      "senderPolicy": "open",
      "legacyField": true
    }
  },
  "serve": { "port": 4123 }
}\n`);
  });

  afterEach(() => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    resetHomeEnvBootstrapForTesting();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('preserves an existing secret unless replace or clear is explicit', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const first = store.snapshot();

    await store.upsert('bot', {
      expectedRevision: first.revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        senderPolicy: 'pairing',
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'],
    ).toEqual({
      type: 'management-validation-test',
      clientId: 'client-id',
      senderPolicy: 'pairing',
      clientSecret: '$BOT_TOKEN',
    });
  });

  it('preserves an existing secret when its operation is omitted', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        senderPolicy: 'pairing',
      },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['clientSecret'],
    ).toBe('$BOT_TOKEN');
  });

  it('replaces and clears secrets only through explicit operations', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "required-secret",
    "optionalSecret": "old-secret"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const replaced = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: { type: 'management-validation-test', clientId: 'client-id' },
      secrets: {
        optionalSecret: { operation: 'replace', value: 'new-secret' },
      },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['optionalSecret'],
    ).toBe('new-secret');

    await store.upsert('bot', {
      expectedRevision: replaced.revision,
      config: { type: 'management-validation-test', clientId: 'client-id' },
      secrets: { optionalSecret: { operation: 'clear' } },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'],
    ).not.toHaveProperty('optionalSecret');
  });

  it('rejects blank replacements and secret keys not declared by the plugin', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const revision = store.snapshot().revision;

    await expect(
      store.upsert('bot', {
        expectedRevision: revision,
        config: { type: 'dingtalk', clientId: 'client-id' },
        secrets: { clientSecret: { operation: 'replace', value: '' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_secret' });
    await expect(
      store.upsert('bot', {
        expectedRevision: revision,
        config: { type: 'dingtalk', clientId: 'client-id' },
        secrets: { secret: { operation: 'clear' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_secret' });
  });

  it('rejects malformed direct secret updates without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const revision = store.snapshot().revision;
    const before = fs.readFileSync(settingsPath, 'utf8');
    const entryName = 'clientSecret';
    const invalidMaps: unknown[] = [
      null,
      [],
      { [entryName]: { operation: 'rotate', value: 'new-secret' } },
      { [entryName]: null },
      { [entryName]: { operation: 'replace', value: '' } },
      { [entryName]: [] },
      { [entryName]: { operation: 'preserve', value: 'unexpected' } },
      ...['__proto__', 'constructor', 'prototype'].map((key) =>
        Object.fromEntries([[key, { operation: 'preserve' }]]),
      ),
    ];

    for (const invalidMap of invalidMaps) {
      const options = {
        expectedRevision: revision,
        config: { type: 'dingtalk', clientId: 'client-id' },
        secrets: invalidMap,
      };
      await expect(store.upsert('bot', options as never)).rejects.toMatchObject(
        { code: 'channel_settings_invalid_secret' },
      );
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    }
  });

  it('rejects channel types without management descriptors', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('custom', {
        expectedRevision: store.snapshot().revision,
        config: { type: 'unmanaged-extension' },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_unmanageable' });
  });

  it.each([
    {
      label: 'missing required DingTalk client ID',
      config: { type: 'dingtalk' },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'missing required DingTalk client secret',
      config: { type: 'dingtalk', clientId: 'client-id' },
      secrets: { clientSecret: { operation: 'preserve' } as const },
    },
    {
      label: 'cleared required DingTalk client secret',
      config: { type: 'dingtalk', clientId: 'client-id' },
      secrets: { clientSecret: { operation: 'clear' } as const },
    },
    {
      label: 'wrong string kind',
      config: { type: 'management-validation-test', clientId: 42 },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'wrong boolean kind',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        enabled: 'yes',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'wrong number kind',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        retries: '3',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'invalid enum option',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        mode: 'turbo',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'environment reference on a non-resolvable field',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        literalOnly: '$LITERAL_ONLY',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'unknown config field',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        unexpected: true,
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'wrong shared field kind',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        allowedUsers: 'user-1',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
  ])('rejects $label without writing', async ({ config, secrets }) => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: config as Record<string, unknown> & { type: string },
        secrets,
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('accepts env-resolvable descriptor fields and typed shared fields', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: '$CLIENT_ID',
        enabled: true,
        retries: 3,
        mode: 'safe',
        senderPolicy: 'open',
        allowedUsers: ['user-1'],
        groupHistoryLimit: 25,
        blockStreaming: 'on',
        identity: { id: 'ops', displayName: 'Ops' },
      },
      secrets: {
        clientSecret: {
          operation: 'replace',
          value: '$CLIENT_SECRET',
        },
      },
    });

    expect(next.channels['bot']).toMatchObject({
      clientId: '$CLIENT_ID',
      clientSecret: '$CLIENT_SECRET',
      enabled: true,
      retries: 3,
      mode: 'safe',
      senderPolicy: 'open',
      allowedUsers: ['user-1'],
      groupHistoryLimit: 25,
      blockStreaming: 'on',
      identity: { id: 'ops', displayName: 'Ops' },
    });
  });

  it('rejects clearing an existing required secret without writing', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: { type: 'dingtalk', clientId: 'client-id' },
        secrets: { clientSecret: { operation: 'clear' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('allows unknown legacy fields only when preserved unchanged', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        senderPolicy: 'pairing',
        legacyField: true,
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']?.['legacyField']).toBe(true);
  });

  it('rejects a stale revision without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.remove('bot', { expectedRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'channel_settings_conflict' });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('does not infer startup from existing channel config', () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    expect(store.snapshot().startupNames).toEqual([]);
  });

  it('writes startup names separately while preserving settings and formatting', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.setStartupNames(['bot'], {
      expectedRevision: store.snapshot().revision,
    });

    const settings = readWorkspaceSettings();
    expect(settings['serve']).toEqual({ port: 4123, channels: ['bot'] });
    expect(settings['general']).toEqual({ vimMode: true });
    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(
      '// Keep this comment and unrelated setting.',
    );
    expect(next.startupNames).toEqual(['bot']);
  });

  it('rejects stale startup names without changing workspace settings', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.setStartupNames(['bot'], { expectedRevision: 'stale' }),
    ).rejects.toMatchObject({ code: 'channel_settings_conflict' });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('removes the channel and its startup selection together', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": { "type": "telegram", "token": "$BOT_TOKEN" } },
  "serve": { "channels": ["other", "bot"] }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.remove('bot', {
      expectedRevision: store.snapshot().revision,
    });

    expect(next.channels).toEqual({});
    expect(next.startupNames).toEqual(['other']);
    expect(readWorkspaceSettings()).toEqual({
      $version: 4,
      channels: {},
      serve: { channels: ['other'] },
    });
  });

  it('preserves the all sentinel when removing a legacy all config beside other instances', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "all": { "type": "telegram", "token": "$ALL_TOKEN" },
    "bot": { "type": "telegram", "token": "$BOT_TOKEN" }
  },
  "serve": { "channels": ["all"] }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.remove('all', {
      expectedRevision: store.snapshot().revision,
    });

    expect(next.channels).toEqual({
      bot: { type: 'telegram', token: '$BOT_TOKEN' },
    });
    expect(next.startupNames).toEqual(['all']);
  });

  it('clears the all sentinel when removing the only legacy all config', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "all": { "type": "telegram", "token": "$ALL_TOKEN" }
  },
  "serve": { "channels": ["all"] }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.remove('all', {
      expectedRevision: store.snapshot().revision,
    });

    expect(next.channels).toEqual({});
    expect(next.startupNames).toEqual([]);
  });

  it('canonicalizes a whitespace all sentinel when removing its legacy config', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    " all ": { "type": "telegram", "token": "$ALL_TOKEN" },
    "bot": { "type": "telegram", "token": "$BOT_TOKEN" }
  },
  "serve": { "channels": [" all ", "bot"] }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.remove(' all ', {
      expectedRevision: store.snapshot().revision,
    });

    expect(next.channels).toEqual({
      bot: { type: 'telegram', token: '$BOT_TOKEN' },
    });
    expect(next.startupNames).toEqual(['all']);
  });

  it('clears a whitespace all sentinel when no selectable configs remain', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    " all ": { "type": "telegram", "token": "$ALL_TOKEN" }
  },
  "serve": { "channels": [" all "] }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.remove(' all ', {
      expectedRevision: store.snapshot().revision,
    });

    expect(next.channels).toEqual({});
    expect(next.startupNames).toEqual([]);
  });

  it('produces the same revision for unchanged persisted values', () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    expect(store.snapshot().revision).toBe(store.snapshot().revision);
  });
});
