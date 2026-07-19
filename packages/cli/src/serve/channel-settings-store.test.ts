/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import stripJsonComments from 'strip-json-comments';
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
      "type": "telegram",
      "token": "$BOT_TOKEN",
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
      config: { type: 'telegram', senderPolicy: 'pairing' },
      secrets: { token: { operation: 'preserve' } },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'],
    ).toEqual({
      type: 'telegram',
      senderPolicy: 'pairing',
      token: '$BOT_TOKEN',
    });
  });

  it('preserves an existing secret when its operation is omitted', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: { type: 'telegram', senderPolicy: 'pairing' },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['token'],
    ).toBe('$BOT_TOKEN');
  });

  it('replaces and clears secrets only through explicit operations', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const replaced = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: { type: 'telegram' },
      secrets: { token: { operation: 'replace', value: 'new-token' } },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['token'],
    ).toBe('new-token');

    await store.upsert('bot', {
      expectedRevision: replaced.revision,
      config: { type: 'telegram' },
      secrets: { token: { operation: 'clear' } },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'],
    ).not.toHaveProperty('token');
  });

  it('rejects blank replacements and secret keys not declared by the plugin', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const revision = store.snapshot().revision;

    await expect(
      store.upsert('bot', {
        expectedRevision: revision,
        config: { type: 'telegram' },
        secrets: { token: { operation: 'replace', value: '' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_secret' });
    await expect(
      store.upsert('bot', {
        expectedRevision: revision,
        config: { type: 'telegram' },
        secrets: { clientSecret: { operation: 'clear' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_secret' });
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

  it('produces the same revision for unchanged persisted values', () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    expect(store.snapshot().revision).toBe(store.snapshot().revision);
  });
});
