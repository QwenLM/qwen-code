/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import stripJsonComments from 'strip-json-comments';
import type { ChannelPlugin } from '@qwen-code/channel-base';
import {
  registerPlugin,
  UNSAFE_OBJECT_KEYS,
} from '../commands/channel/channel-registry.js';
import {
  loadSettings,
  resetHomeEnvBootstrapForTesting,
} from '../config/settings.js';
import { WorkspaceChannelSettingsStore } from './channel-settings-store.js';

let mockHomeDir = '';
vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof import('node:os')>();
  // Mock both the named and the default export: consumers do
  // `import os from 'node:os'`, which a bare spread would leave unmocked.
  const homedir = () => mockHomeDir;
  return {
    ...actualOs,
    homedir,
    default: { ...actualOs, homedir },
  };
});

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

  const readStoredChannel = (
    name: string,
  ): Record<string, unknown> | undefined =>
    (
      readWorkspaceSettings()['channels'] as Record<
        string,
        Record<string, unknown>
      >
    )[name];

  // A stored `$VAR` reference only proves the write set came from the stored
  // form while the variable resolves to something else, so the reference tests
  // below all run with their variables defined.
  const withEnv = async (
    vars: Record<string, string>,
    body: () => Promise<void>,
  ): Promise<void> => {
    const saved = Object.fromEntries(
      Object.keys(vars).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, vars);
    try {
      await body();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };

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
            key: 'backoffSeconds',
            label: 'Backoff seconds',
            kind: 'number',
            exclusiveMinimum: 0,
          },
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
          { key: 'tags', label: 'Tags', kind: 'string-list' },
          {
            key: 'templates',
            label: 'Templates',
            kind: 'record',
            options: [
              { value: 'greeting', label: 'Greeting' },
              { value: 'farewell', label: 'Farewell' },
            ],
          },
          {
            key: 'nested',
            label: 'Nested',
            kind: 'object',
            properties: [
              {
                key: 'requiredValue',
                label: 'Required value',
                kind: 'string',
                required: true,
              },
            ],
          },
        ],
      },
      createChannel() {
        throw new Error('not used');
      },
    });
    registerPlugin({
      channelType: 'non-user-default-management-test',
      displayName: 'Non-user default management test',
      defaultSessionScope: 'chat_thread',
      management: { fields: [] },
      createChannel() {
        throw new Error('not used');
      },
    });
    registerPlugin({
      channelType: 'user-default-management-test',
      displayName: 'User default management test',
      management: { fields: [] },
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
    mockHomeDir = path.join(testRoot, 'unused-home');
    fs.mkdirSync(mockHomeDir, { recursive: true });
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
    // The stored secret is an environment reference, so the assertion below only
    // means something with the variable defined: while it is unset, resolution
    // is a no-op and the reference survives whether or not the write set is
    // derived from the stored form.
    const savedBotToken = process.env['BOT_TOKEN'];
    process.env['BOT_TOKEN'] = 'sekret-plaintext';
    try {
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
    } finally {
      if (savedBotToken === undefined) {
        delete process.env['BOT_TOKEN'];
      } else {
        process.env['BOT_TOKEN'] = savedBotToken;
      }
    }
  });

  it('preserves an existing secret when its operation is omitted', async () => {
    // As in the test above, the stored reference only proves the write set came
    // from the stored form while the variable resolves to something else.
    const savedBotToken = process.env['BOT_TOKEN'];
    process.env['BOT_TOKEN'] = 'sekret-plaintext';
    try {
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
    } finally {
      if (savedBotToken === undefined) {
        delete process.env['BOT_TOKEN'];
      } else {
        process.env['BOT_TOKEN'] = savedBotToken;
      }
    }
  });

  it('keeps a stored secret reference when the stored type is a reference', async () => {
    // The client sends the resolved type, so the type-match gate has to be taken
    // from the env-resolved stored config. Gating the stored-form lookup on the
    // raw on-disk type instead makes the two guards disagree for a stored
    // "$CH_TYPE", skips the restore, and writes the resolved secret to disk in
    // plaintext.
    const savedBotToken = process.env['BOT_TOKEN'];
    const savedChannelType = process.env['CH_TYPE'];
    process.env['BOT_TOKEN'] = 'sekret-plaintext';
    process.env['CH_TYPE'] = 'management-validation-test';
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "bot": {
      "type": "$CH_TYPE",
      "clientId": "client-id",
      "clientSecret": "$BOT_TOKEN"
    }
  }
}\n`);
    try {
      const store = new WorkspaceChannelSettingsStore(workspace);
      const initial = store.snapshot();
      // Precondition: both references resolved, so the snapshot the management
      // UI reads, and the config it sends back, carry the resolved values.
      expect(initial.channels['bot']).toMatchObject({
        type: 'management-validation-test',
        clientSecret: 'sekret-plaintext',
      });

      await store.upsert('bot', {
        expectedRevision: initial.revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          senderPolicy: 'pairing',
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      });

      const persisted = (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'];
      expect(persisted?.['clientSecret']).toBe('$BOT_TOKEN');
      // The harm being pinned is a plaintext secret at rest, so check the raw
      // file too: the resolved value must not reach disk anywhere in the entry.
      expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain(
        'sekret-plaintext',
      );
    } finally {
      if (savedBotToken === undefined) {
        delete process.env['BOT_TOKEN'];
      } else {
        process.env['BOT_TOKEN'] = savedBotToken;
      }
      if (savedChannelType === undefined) {
        delete process.env['CH_TYPE'];
      } else {
        process.env['CH_TYPE'] = savedChannelType;
      }
    }
  });

  it.each([...UNSAFE_OBJECT_KEYS])(
    'does not read a channel planted under a reserved key (%s)',
    async (reservedKey) => {
      // All three reserved keys stay own keys through JSON.parse, so a settings
      // file can carry a channel the read view must never list. Building the
      // stored-form map by assignment turns `__proto__` into that map's
      // prototype, which the spread read view cannot see, and turns
      // `constructor`/`prototype` into own properties it lists and hashes into
      // the revision. So the read view is the discriminating assertion here,
      // and only for `constructor`/`prototype`; the `__proto__` arm is defence
      // in depth. The persisted subtree carries no reserved key even unguarded,
      // so the write-set assertion below pins the user's channel, not the guard.
      writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "${reservedKey}": {
      "planted-bot": {
        "type": "management-validation-test",
        "clientId": "planted-client",
        "optionalSecret": "$ATTACKER_TOKEN"
      }
    }
  }
}\n`);
      const store = new WorkspaceChannelSettingsStore(workspace);
      const initial = store.snapshot();
      expect(initial.channels).toEqual({});

      await store.upsert('planted-bot', {
        expectedRevision: initial.revision,
        config: {
          type: 'management-validation-test',
          clientId: 'user-client',
        },
        secrets: {
          clientSecret: { operation: 'replace', value: 'user-secret' },
        },
      });

      expect(
        (
          readWorkspaceSettings()['channels'] as Record<
            string,
            Record<string, unknown>
          >
        )['planted-bot'],
      ).toEqual({
        type: 'management-validation-test',
        clientId: 'user-client',
        clientSecret: 'user-secret',
      });
    },
  );

  it('keeps a non-secret stored reference when an unrelated field is edited', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "bot": {
      "type": "management-validation-test",
      "clientId": "$CLIENT_ID",
      "clientSecret": "$BOT_TOKEN",
      "senderPolicy": "open"
    }
  }
}\n`);

    await withEnv(
      { CLIENT_ID: 'resolved-client-id', BOT_TOKEN: 'sekret-plaintext' },
      async () => {
        const store = new WorkspaceChannelSettingsStore(workspace);
        const first = store.snapshot();
        // The editor seeds its form from this env-resolved snapshot, so the
        // literal below is the only value a client can send back for a field the
        // operator never touched.
        expect(first.channels['bot']?.['clientId']).toBe('resolved-client-id');

        await store.upsert('bot', {
          expectedRevision: first.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'resolved-client-id',
            senderPolicy: 'pairing',
          },
          secrets: { clientSecret: { operation: 'preserve' } },
        });

        expect(readStoredChannel('bot')).toEqual({
          type: 'management-validation-test',
          clientId: '$CLIENT_ID',
          clientSecret: '$BOT_TOKEN',
          senderPolicy: 'pairing',
        });
      },
    );
  });

  it('persists a deliberately edited value over a stored reference', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "bot": {
      "type": "management-validation-test",
      "clientId": "$CLIENT_ID",
      "clientSecret": "$BOT_TOKEN",
      "senderPolicy": "open"
    }
  }
}\n`);

    await withEnv(
      { CLIENT_ID: 'resolved-client-id', BOT_TOKEN: 'sekret-plaintext' },
      async () => {
        const store = new WorkspaceChannelSettingsStore(workspace);
        const first = store.snapshot();

        await store.upsert('bot', {
          expectedRevision: first.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'pinned-client-id',
            senderPolicy: 'open',
          },
          secrets: { clientSecret: { operation: 'preserve' } },
        });

        // Restoring only an echoed-back value is what keeps this from swallowing
        // a real edit: the operator asked for a literal, so a literal is stored.
        expect(readStoredChannel('bot')).toEqual({
          type: 'management-validation-test',
          clientId: 'pinned-client-id',
          clientSecret: '$BOT_TOKEN',
          senderPolicy: 'open',
        });
      },
    );
  });

  it('does not write back a reference on a secret field that forbids one', async () => {
    // `optionalSecret` declares no `envResolvable`, so `assertDescriptorValue`
    // rejects a bare `$OPT` there. The restore runs after validation, so writing
    // a hand-authored reference back would persist a value the daemon refuses to
    // read: the next start without OPT resolves it to the placeholder itself and
    // every later upsert throws on a field the caller never sent.
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": {
    "bot": {
      "type": "management-validation-test",
      "clientId": "client-id",
      "clientSecret": "$BOT_TOKEN",
      "optionalSecret": "$OPT",
      "senderPolicy": "open"
    }
  }
}\n`);

    await withEnv(
      { OPT: 'hunter2', BOT_TOKEN: 'sekret-plaintext' },
      async () => {
        const store = new WorkspaceChannelSettingsStore(workspace);
        const first = store.snapshot();
        expect(first.channels['bot']?.['optionalSecret']).toBe('hunter2');

        await store.upsert('bot', {
          expectedRevision: first.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'client-id',
            senderPolicy: 'pairing',
          },
          secrets: {
            clientSecret: { operation: 'preserve' },
            optionalSecret: { operation: 'preserve' },
          },
        });

        // `clientSecret` keeps its reference (it declares `envResolvable`), so the
        // gate is the descriptor and not a blanket "never restore a secret".
        expect(readStoredChannel('bot')).toEqual({
          type: 'management-validation-test',
          clientId: 'client-id',
          clientSecret: '$BOT_TOKEN',
          optionalSecret: 'hunter2',
          senderPolicy: 'pairing',
        });
      },
    );
  });

  it('accepts chat-and-thread session scope', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        sessionScope: 'chat_thread',
      },
    });

    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['sessionScope'],
    ).toBe('chat_thread');
  });

  it('round-trips a managed message prefix', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        messagePrefix: '/review',
      },
    });

    expect(next.channels['bot']?.['messagePrefix']).toBe('/review');
    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['messagePrefix'],
    ).toBe('/review');
  });

  it('rejects a non-string managed message prefix', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          messagePrefix: 42,
        } as never,
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "messagePrefix" must be a string.',
    });
  });

  it.each([
    {
      label: 'an explicit non-user session scope',
      type: 'user-default-management-test',
      extra: { sessionScope: 'chat_thread' },
      message: 'requires sessionScope "user"',
    },
    {
      label: 'a plugin non-user default session scope',
      type: 'non-user-default-management-test',
      extra: {},
      message: 'requires sessionScope "user"',
    },
    {
      label: 'channel group history',
      type: 'user-default-management-test',
      extra: { groupHistoryLimit: 1 },
      message: 'cannot use groupHistoryLimit',
    },
    {
      label: 'per-group history',
      type: 'user-default-management-test',
      extra: {
        groups: { group1: { groupHistoryLimit: 1 } },
      },
      message: 'group "group1" cannot use groupHistoryLimit',
    },
  ])('rejects multiSession with $label', async ({ type, extra, message }) => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('named-bot', {
        expectedRevision: store.snapshot().revision,
        config: { type, multiSession: true, ...extra },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: expect.stringContaining(message),
    });
  });

  it('rejects enabling multiSession while preserving webhook config', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "named-bot": {
    "type": "user-default-management-test",
    "webhooks": { "sources": {} }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('named-bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'user-default-management-test',
          multiSession: true,
          webhooks: { sources: {} },
        },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: expect.stringContaining('cannot use webhooks'),
    });
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
      label: 'number at the exclusive minimum',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        backoffSeconds: 0,
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
    {
      label: 'invalid group allowlist entry',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        groups: { 'group-1': { dispatchMode: 'invalid' } },
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'wrong nested dispatch mode kind',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        groups: { 'group-1': { dispatchMode: ['collect'] } },
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'string-list with non-string items',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        tags: [1, 2],
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'string-list not an array',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        tags: 'single',
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' } as const,
      },
    },
    {
      label: 'record with non-string value',
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        templates: { greeting: 123 },
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
        backoffSeconds: 2.5,
        mode: 'safe',
        senderPolicy: 'open',
        groupPolicy: 'pairing',
        sessionScope: 'chat_thread',
        allowedUsers: ['user-1'],
        groups: {
          '*': { requireMention: false },
          'group-1': { dispatchMode: 'collect', groupHistoryLimit: 25 },
        },
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
      backoffSeconds: 2.5,
      mode: 'safe',
      senderPolicy: 'open',
      groupPolicy: 'pairing',
      sessionScope: 'chat_thread',
      allowedUsers: ['user-1'],
      groups: {
        '*': { requireMention: false },
        'group-1': { dispatchMode: 'collect', groupHistoryLimit: 25 },
      },
      groupHistoryLimit: 25,
      blockStreaming: 'on',
      identity: { id: 'ops', displayName: 'Ops' },
    });
  });

  it('accepts string-list and record descriptor fields', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'client-id',
        tags: ['alpha', 'beta'],
        templates: {
          greeting: 'hi %user%',
          farewell: 'bye',
          // record options are UI hints, not a closed set: undeclared keys
          // must be accepted (GitLab action_name set drifts server-side)
          attention_requested: 'ping',
        },
      },
      secrets: {
        clientSecret: { operation: 'replace', value: 'secret' },
      },
    });

    expect(next.channels['bot']).toMatchObject({
      tags: ['alpha', 'beta'],
      templates: {
        greeting: 'hi %user%',
        farewell: 'bye',
        attention_requested: 'ping',
      },
    });
  });

  it('persists DingTalk interactive card configuration through management metadata', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        interactiveCards: {
          enabled: true,
          statusCard: { enabled: true },
          questionCard: { enabled: true, timeoutMs: 270_000 },
        },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']?.['interactiveCards']).toEqual({
      enabled: true,
      statusCard: { enabled: true },
      questionCard: { enabled: true, timeoutMs: 270_000 },
    });
  });

  it('preserves an unchanged stored object value that fails current validation', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": {
      "questionCard": { "enabled": true, "timeoutMs": 0 }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'updated-id',
        interactiveCards: { questionCard: { enabled: true, timeoutMs: 0 } },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({ clientId: 'updated-id' });
    expect(next.channels['bot']?.['interactiveCards']).toEqual({
      questionCard: { enabled: true, timeoutMs: 0 },
    });

    const beforeRejectedWrite = fs.readFileSync(settingsPath, 'utf8');
    await expect(
      store.upsert('bot', {
        expectedRevision: next.revision,
        config: {
          type: 'dingtalk',
          clientId: 'updated-id',
          interactiveCards: { questionCard: { enabled: true, timeoutMs: -1 } },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message:
        'Channel field "interactiveCards.questionCard.timeoutMs" has an invalid value.',
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(beforeRejectedWrite);
  });

  it('preserves unchanged legacy group settings while editing another field', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "groups": { "group-1": { "mentionKeywords": ["@bot"] } }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'updated-id',
        groups: { 'group-1': { mentionKeywords: ['@bot'] } },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({
      clientId: 'updated-id',
      groups: { 'group-1': { mentionKeywords: ['@bot'] } },
    });
  });

  it.each([
    { stored: null, changed: [] },
    { stored: [], changed: null },
  ])(
    'preserves unchanged non-record groups but rejects a changed value',
    async ({ stored, changed }) => {
      writeWorkspaceSettings(
        JSON.stringify({
          $version: 4,
          channels: {
            bot: {
              type: 'management-validation-test',
              clientId: 'client-id',
              clientSecret: 'existing-secret',
              groups: stored,
            },
          },
        }),
      );
      const store = new WorkspaceChannelSettingsStore(workspace);

      const next = await store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'updated-id',
          groups: stored,
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      });

      expect(next.channels['bot']).toMatchObject({
        clientId: 'updated-id',
        groups: stored,
      });

      await expect(
        store.upsert('bot', {
          expectedRevision: next.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'updated-id',
            groups: changed,
          },
          secrets: { clientSecret: { operation: 'preserve' } },
        }),
      ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });
    },
  );

  it('rejects unchanged non-record groups containing an unsafe key', async () => {
    const groups = [JSON.parse('{"__proto__":{"polluted":true}}') as unknown];
    writeWorkspaceSettings(
      JSON.stringify({
        $version: 4,
        channels: {
          bot: {
            type: 'management-validation-test',
            clientId: 'client-id',
            clientSecret: 'existing-secret',
            groups,
          },
        },
      }),
    );
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'updated-id',
          groups,
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });
  });

  it('preserves unchanged legacy values in known group fields', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "groups": {
      "*": { "requireMention": "yes", "dispatchMode": "collect" }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'updated-id',
        groups: { '*': { requireMention: 'yes', dispatchMode: 'steer' } },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({
      clientId: 'updated-id',
      groups: { '*': { requireMention: 'yes', dispatchMode: 'steer' } },
    });

    await expect(
      store.upsert('bot', {
        expectedRevision: next.revision,
        config: {
          type: 'management-validation-test',
          clientId: 'updated-id',
          groups: { '*': { requireMention: 'no', dispatchMode: 'steer' } },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });
  });

  it('rejects reserved keys inside unchanged known group fields', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "groups": {
      "*": { "requireMention": { "__proto__": { "legacy": true } } }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'updated-id',
          groups: {
            '*': {
              requireMention: JSON.parse(
                '{"__proto__":{"legacy":true}}',
              ) as unknown,
            },
          },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({ code: 'channel_settings_invalid_config' });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('re-validates an unchanged stored scalar instead of preserving it', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "retries": "3"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          retries: '3',
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "retries" has an invalid value.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('preserves an unchanged invalid nested object while a sibling property changes', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": {
      "enabled": false,
      "questionCard": { "enabled": true, "timeoutMs": 0 }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'client-id',
        interactiveCards: {
          enabled: true,
          questionCard: { enabled: true, timeoutMs: 0 },
        },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']?.['interactiveCards']).toEqual({
      enabled: true,
      questionCard: { enabled: true, timeoutMs: 0 },
    });
  });

  it('preserves an unchanged stored non-record object value', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": null
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'updated-id',
        interactiveCards: null,
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({
      clientId: 'updated-id',
      interactiveCards: null,
    });

    const beforeRejectedWrite = fs.readFileSync(settingsPath, 'utf8');
    await expect(
      store.upsert('bot', {
        expectedRevision: next.revision,
        config: {
          type: 'dingtalk',
          clientId: 'updated-id',
          interactiveCards: [],
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "interactiveCards" has an invalid value.',
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(beforeRejectedWrite);
  });

  it('preserves an unchanged stored object that omits a now-required nested property', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "nested": {}
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'updated-id',
        nested: {},
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({ clientId: 'updated-id' });
    expect(next.channels['bot']?.['nested']).toEqual({});
  });

  it('drops an omitted object field and leaves its nested required unchecked', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "nested": { "requiredValue": "kept" }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'management-validation-test',
        clientId: 'updated-id',
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({ clientId: 'updated-id' });
    expect(next.channels['bot']).not.toHaveProperty('nested');
    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot'],
    ).not.toHaveProperty('nested');
  });

  it('replaces nested object values wholesale without merging partial writes', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": {
      "enabled": false,
      "questionCard": { "enabled": true, "timeoutMs": 270000 }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'updated-id',
        interactiveCards: {
          enabled: true,
          questionCard: { enabled: true },
        },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']?.['interactiveCards']).toEqual({
      enabled: true,
      questionCard: { enabled: true },
    });
    expect(
      (
        readWorkspaceSettings()['channels'] as Record<
          string,
          Record<string, unknown>
        >
      )['bot']?.['interactiveCards'],
    ).toEqual({ enabled: true, questionCard: { enabled: true } });
  });

  it('accepts environment references on fields with truthy non-boolean envResolvable', async () => {
    registerPlugin({
      channelType: 'untyped-env-resolvable',
      displayName: 'Untyped env resolvable',
      management: {
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
          },
          {
            key: 'endpoint',
            label: 'Endpoint',
            kind: 'string',
            envResolvable: 'yes',
          },
        ],
      },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'untyped-env-resolvable',
        clientId: 'client-id',
        endpoint: '$ENDPOINT',
      },
    });

    expect(next.channels['bot']).toMatchObject({
      clientId: 'client-id',
      endpoint: '$ENDPOINT',
    });
  });

  it('rejects an omitted required nested descriptor property without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          nested: {},
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "nested.requiredValue" is required.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('reports the full path for nested environment references', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'dingtalk',
          clientId: 'client-id',
          interactiveCards: { statusCard: { enabled: '$STATUS_CARD' } },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message:
        'Channel field "interactiveCards.statusCard.enabled" does not support environment references.',
    });
  });

  it('only preserves unknown nested legacy fields when they are unchanged', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": {
      "enabled": true,
      "questionCard": {
        "enabled": true,
        "legacyFlag": 1
      }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'dingtalk',
        clientId: 'updated-id',
        interactiveCards: {
          enabled: true,
          questionCard: { enabled: false, legacyFlag: 1 },
        },
      },
      secrets: { clientSecret: { operation: 'preserve' } },
    });

    expect(next.channels['bot']).toMatchObject({ clientId: 'updated-id' });
    expect(next.channels['bot']?.['interactiveCards']).toEqual({
      enabled: true,
      questionCard: { enabled: false, legacyFlag: 1 },
    });

    const beforeRejectedWrite = fs.readFileSync(settingsPath, 'utf8');
    await expect(
      store.upsert('bot', {
        expectedRevision: next.revision,
        config: {
          type: 'dingtalk',
          clientId: 'updated-id',
          interactiveCards: {
            enabled: true,
            questionCard: { enabled: false, legacyFlag: 2 },
          },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message:
        'Channel field "interactiveCards.questionCard.legacyFlag" is not manageable.',
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(beforeRejectedWrite);
  });

  it('rejects an unchanged reserved nested key instead of preserving it', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": {
      "questionCard": {
        "enabled": true,
        "constructor": { "legacy": true }
      }
    }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'dingtalk',
          clientId: 'client-id',
          interactiveCards: {
            questionCard: { enabled: true, constructor: { legacy: true } },
          },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message:
        'Channel field "interactiveCards.questionCard.constructor" is not manageable.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('rejects an unchanged reserved top-level key instead of preserving it', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "management-validation-test",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "prototype": { "legacy": true }
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          prototype: { legacy: true },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "prototype" is not manageable.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it.each([
    {
      label: 'reserved key nested under a legacy key',
      legacy: { constructor: { legacy: true } },
    },
    {
      label: 'reserved key inside a legacy array',
      legacy: [{ ['__proto__']: { legacy: true } }],
    },
  ])(
    'rejects a stored interactiveCards value with a $label',
    async ({ legacy }) => {
      writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "dingtalk",
    "clientId": "client-id",
    "clientSecret": "existing-secret",
    "interactiveCards": { "legacy": ${JSON.stringify(legacy)} }
  } }
}\n`);
      const store = new WorkspaceChannelSettingsStore(workspace);
      const before = fs.readFileSync(settingsPath, 'utf8');

      await expect(
        store.upsert('bot', {
          expectedRevision: store.snapshot().revision,
          config: {
            type: 'dingtalk',
            clientId: 'client-id',
            interactiveCards: { legacy },
          },
          secrets: { clientSecret: { operation: 'preserve' } },
        }),
      ).rejects.toMatchObject({
        code: 'channel_settings_invalid_config',
        message:
          'Channel field "interactiveCards.legacy" cannot use a reserved key.',
      });

      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    },
  );

  it('rejects reserved keys inside record field values without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'management-validation-test',
          clientId: 'client-id',
          templates: { ['__proto__']: 'polluted' },
        },
        secrets: { clientSecret: { operation: 'preserve' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel field "templates" has an invalid value.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('rejects a validateConfig that returns a Promise instead of an error message', async () => {
    registerPlugin({
      channelType: 'promise-validate-config',
      displayName: 'Promise validate config',
      management: {
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
          },
        ],
        validateConfig: () => Promise.resolve(undefined),
      },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: { type: 'promise-validate-config', clientId: 'client-id' },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel validateConfig must return a string error message.',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('does not leak a rejection when validateConfig returns a rejected Promise', async () => {
    registerPlugin({
      channelType: 'rejected-promise-validate-config',
      displayName: 'Rejected promise validate config',
      management: {
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
          },
        ],
        validateConfig: () => Promise.reject(new Error('network down')),
      },
      createChannel() {
        throw new Error('not used');
      },
    } as unknown as ChannelPlugin);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        store.upsert('bot', {
          expectedRevision: store.snapshot().revision,
          config: {
            type: 'rejected-promise-validate-config',
            clientId: 'client-id',
          },
        }),
      ).rejects.toMatchObject({
        code: 'channel_settings_invalid_config',
        message: 'Channel validateConfig must return a string error message.',
      });
      // Give the rejection a tick to surface if it were left unhandled.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('rejects a throwing validateConfig as an invalid config error', async () => {
    registerPlugin({
      channelType: 'throwing-validate-config',
      displayName: 'Throwing validate config',
      management: {
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            kind: 'string',
            required: true,
          },
        ],
        validateConfig: (): string => {
          throw new TypeError('note is missing');
        },
      },
      createChannel() {
        throw new Error('not used');
      },
    });
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: { type: 'throwing-validate-config', clientId: 'client-id' },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: 'Channel validateConfig failed: note is missing',
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it.each([
    {
      label: 'non-object value',
      interactiveCards: 'enabled',
      expectedMessage: 'Channel field "interactiveCards" has an invalid value.',
    },
    {
      label: 'string enabled flag',
      interactiveCards: { enabled: 'true' },
      expectedMessage:
        'Channel field "interactiveCards.enabled" has an invalid value.',
    },
    {
      label: 'invalid nested enabled flag',
      interactiveCards: { statusCard: { enabled: 'true' } },
      expectedMessage:
        'Channel field "interactiveCards.statusCard.enabled" has an invalid value.',
    },
    {
      label: 'non-positive question timeout',
      interactiveCards: { questionCard: { timeoutMs: 0 } },
      expectedMessage:
        'Channel field "interactiveCards.questionCard.timeoutMs" has an invalid value.',
    },
    {
      label: 'unknown nested field',
      interactiveCards: { unexpected: true },
      expectedMessage:
        'Channel field "interactiveCards.unexpected" is not manageable.',
    },
  ])(
    'rejects DingTalk interactive card configuration with $label',
    async ({ interactiveCards, expectedMessage }) => {
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
          config: {
            type: 'dingtalk',
            clientId: 'client-id',
            interactiveCards,
          },
          secrets: { clientSecret: { operation: 'preserve' } },
        }),
      ).rejects.toMatchObject({
        code: 'channel_settings_invalid_config',
        message: expectedMessage,
      });

      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    },
  );

  it('rejects a github channel with neither token nor local gh authentication without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'github',
          senderPolicy: 'allowlist',
          groupPolicy: 'open',
        },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: expect.stringContaining('local GitHub CLI authentication'),
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('rejects clearing the github token without local gh authentication', async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "github",
    "token": "existing-token",
    "senderPolicy": "allowlist",
    "groupPolicy": "open"
  } }
}\n`);
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    await expect(
      store.upsert('bot', {
        expectedRevision: store.snapshot().revision,
        config: {
          type: 'github',
          senderPolicy: 'allowlist',
          groupPolicy: 'open',
        },
        secrets: { token: { operation: 'clear' } },
      }),
    ).rejects.toMatchObject({
      code: 'channel_settings_invalid_config',
      message: expect.stringContaining('local GitHub CLI authentication'),
    });

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('accepts a github channel that enables local gh authentication without a token', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);

    const next = await store.upsert('bot', {
      expectedRevision: store.snapshot().revision,
      config: {
        type: 'github',
        useLocalGh: true,
        senderPolicy: 'allowlist',
        groupPolicy: 'open',
        allowedUsers: ['operator'],
      },
    });

    expect(next.channels['bot']).toMatchObject({
      type: 'github',
      useLocalGh: true,
      senderPolicy: 'allowlist',
      groupPolicy: 'open',
    });
  });

  it("does not carry a previous type's stored secret into a changed type", async () => {
    writeWorkspaceSettings(`{
  "$version": 4,
  "channels": { "bot": {
    "type": "gitlab",
    "token": "$GL_TOKEN",
    "senderPolicy": "open",
    "groupPolicy": "open"
  } }
}\n`);

    await withEnv({ GL_TOKEN: 'gl-pat-PLAIN' }, async () => {
      const store = new WorkspaceChannelSettingsStore(workspace);
      const initial = store.snapshot();

      await store.upsert('bot', {
        expectedRevision: initial.revision,
        config: {
          type: 'github',
          useLocalGh: true,
          senderPolicy: 'open',
          groupPolicy: 'open',
        },
      });

      // gitlab and github both declare `token`, but github's is optional and
      // `useLocalGh` satisfies its validation, so nothing on the write path
      // rejects a reference carried over from the previous type.
      const persisted = readStoredChannel('bot');
      expect(persisted).toMatchObject({ type: 'github', useLocalGh: true });
      expect(persisted).not.toHaveProperty('token');
      expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain(
        'gl-pat-PLAIN',
      );
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

  it('ignores invalid stored channel values in snapshots', () => {
    writeWorkspaceSettings(`{
  "channels": {
    "valid": { "type": "management-validation-test" },
    "null": null,
    "scalar": 42,
    "array": []
  }
}\n`);

    expect(
      new WorkspaceChannelSettingsStore(workspace).snapshot().channels,
    ).toEqual({
      valid: { type: 'management-validation-test' },
    });
  });

  it('rejects unsafe channel names without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    for (const name of ['__proto__', 'constructor', 'prototype']) {
      await expect(
        store.upsert(name, {
          expectedRevision: store.snapshot().revision,
          config: {
            type: 'management-validation-test',
            clientId: 'client-id',
          },
        }),
      ).rejects.toMatchObject({ code: 'channel_settings_invalid_name' });
      await expect(
        store.remove(name, { expectedRevision: store.snapshot().revision }),
      ).rejects.toMatchObject({ code: 'channel_settings_invalid_name' });
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    }
  });

  it('rejects names reserved for the all startup sentinel without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    for (const name of ['all', ' all ']) {
      await expect(
        store.upsert(name, {
          expectedRevision: store.snapshot().revision,
          config: {
            type: 'management-validation-test',
            clientId: 'client-id',
          },
        }),
      ).rejects.toMatchObject({ code: 'channel_settings_invalid_name' });
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    }
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

  it('rejects unsafe startup names without writing', async () => {
    const store = new WorkspaceChannelSettingsStore(workspace);
    const before = fs.readFileSync(settingsPath, 'utf8');

    for (const name of ['__proto__', 'constructor', 'prototype']) {
      await expect(
        store.setStartupNames([name], {
          expectedRevision: store.snapshot().revision,
        }),
      ).rejects.toMatchObject({ code: 'channel_settings_invalid_name' });
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    }
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

  describe('home-directory workspace', () => {
    // The home-directory layout with the user scope redirected away from
    // `<workspace>/.qwen`, so a write that targets the workspace scope lands in
    // a file no scope reads. `mockHomeDir` has to be a directory that exists:
    // the loader calls `realpathSync` on the home directory unguarded.
    const useRedirectedUserScope = (userSettings: Record<string, unknown>) => {
      const redirectedHome = path.join(testRoot, 'redirected-home');
      const userSettingsPath = path.join(redirectedHome, 'settings.json');
      fs.mkdirSync(redirectedHome, { recursive: true });
      fs.writeFileSync(userSettingsPath, JSON.stringify(userSettings));
      process.env['QWEN_HOME'] = redirectedHome;
      mockHomeDir = workspace;
      resetHomeEnvBootstrapForTesting();
      return userSettingsPath;
    };

    const readUserSettings = (userSettingsPath: string) =>
      JSON.parse(
        stripJsonComments(fs.readFileSync(userSettingsPath, 'utf8')),
      ) as {
        channels?: Record<string, Record<string, unknown>>;
        serve?: { channels?: string[] };
      };

    it('keeps channel configs readable when the workspace is the home directory', async () => {
      // A daemon whose workspace is the user's home directory disables the
      // workspace settings scope; the shared settings file is attributed to
      // the user scope instead. Point the user scope at the workspace file
      // (no QWEN_HOME redirect, homedir() === workspace) to reproduce it.
      const savedQwenHome = process.env['QWEN_HOME'];
      delete process.env['QWEN_HOME'];
      mockHomeDir = workspace;
      resetHomeEnvBootstrapForTesting();
      try {
        // The node:os mock has to cover the default export too: consumers that
        // do `import os from 'node:os'` (this file, core's paths.ts) would
        // otherwise resolve the real home directory and write outside
        // testRoot while the suite still reports green.
        expect(os.homedir()).toBe(workspace);
        // Pin the branch under test: the loader has to attribute the shared
        // settings file to the user scope. Mocking `os.homedir()` alone does not
        // prove that — if the mock ever stops reaching the loader, this test
        // would silently exercise the workspace-scope branch against the real
        // `~/.qwen/settings.json` and still pass.
        expect(
          loadSettings(workspace, { skipLoadEnvironment: true })
            .workspaceSettingsActive,
        ).toBe(false);

        const store = new WorkspaceChannelSettingsStore(workspace);
        const initial = store.snapshot();
        expect(initial.channels).toHaveProperty('bot');

        const next = await store.upsert('home-bot', {
          expectedRevision: initial.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'home-client',
            senderPolicy: 'open',
          },
          secrets: { clientSecret: { operation: 'replace', value: 's' } },
        });
        expect(next.channels).toHaveProperty('home-bot');
        // saveSettings replaces the whole `channels` subtree, so the
        // pre-existing channel survives only because the write set is derived
        // from the scope this store reads.
        expect(next.channels).toHaveProperty('bot');

        // The written config must survive a fresh read from disk.
        const reread = new WorkspaceChannelSettingsStore(workspace);
        expect(reread.snapshot().channels['home-bot']).toMatchObject({
          type: 'management-validation-test',
          clientId: 'home-client',
        });
        expect(reread.snapshot().channels).toHaveProperty('bot');
      } finally {
        if (savedQwenHome === undefined) {
          delete process.env['QWEN_HOME'];
        } else {
          process.env['QWEN_HOME'] = savedQwenHome;
        }
        resetHomeEnvBootstrapForTesting();
      }
    });

    it('writes channel configs to the scope it reads them from', async () => {
      // Same home-directory layout, but QWEN_HOME redirects the user scope to
      // another directory. Reads come from the redirected file, so writes have
      // to land there too instead of `<workspace>/.qwen/settings.json`, which
      // no scope reads in this layout.
      const userSettingsPath = useRedirectedUserScope({
        $version: 4,
        channels: {
          'user-bot': {
            type: 'management-validation-test',
            clientId: 'user-client',
            clientSecret: 'user-secret',
          },
        },
      });
      try {
        const store = new WorkspaceChannelSettingsStore(workspace);
        const initial = store.snapshot();
        expect(initial.channels).toHaveProperty('user-bot');

        const next = await store.upsert('home-bot', {
          expectedRevision: initial.revision,
          config: {
            type: 'management-validation-test',
            clientId: 'home-client',
            senderPolicy: 'open',
          },
          secrets: { clientSecret: { operation: 'replace', value: 's' } },
        });
        expect(next.channels).toHaveProperty('home-bot');
        expect(next.channels).toHaveProperty('user-bot');

        expect(readUserSettings(userSettingsPath).channels).toHaveProperty(
          'home-bot',
        );
        // The workspace-scope file must not turn into a second channel store
        // that no read path consults.
        expect(readWorkspaceSettings()['channels']).not.toHaveProperty(
          'home-bot',
        );
      } finally {
        resetHomeEnvBootstrapForTesting();
      }
    });

    it("keeps a sibling channel's stored environment reference on save", async () => {
      const userSettingsPath = useRedirectedUserScope({
        $version: 4,
        channels: {
          bot: {
            type: 'management-validation-test',
            clientId: 'client-id',
            clientSecret: '$BOT_TOKEN',
          },
        },
      });
      const savedBotToken = process.env['BOT_TOKEN'];
      process.env['BOT_TOKEN'] = 'sekret-plaintext';
      try {
        const store = new WorkspaceChannelSettingsStore(workspace);

        // A save replaces the whole `channels` subtree, so the untouched
        // sibling is rewritten from whatever the write set is derived from.
        // Deriving it from the resolved settings would leave the literal token
        // at rest in the user-global file.
        await store.upsert('alerts', {
          expectedRevision: store.snapshot().revision,
          config: {
            type: 'management-validation-test',
            clientId: 'alerts-client',
          },
          secrets: { clientSecret: { operation: 'replace', value: 'a' } },
        });

        expect(
          readUserSettings(userSettingsPath).channels?.['bot']?.[
            'clientSecret'
          ],
        ).toBe('$BOT_TOKEN');
        // Pin the destination too: the redirected user file already holds
        // `bot.clientSecret: '$BOT_TOKEN'`, so without these the assertion above
        // still passes when the write goes to the workspace scope instead.
        expect(readUserSettings(userSettingsPath).channels).toHaveProperty(
          'alerts',
        );
        expect(readWorkspaceSettings()['channels']).not.toHaveProperty(
          'alerts',
        );
      } finally {
        if (savedBotToken === undefined) {
          delete process.env['BOT_TOKEN'];
        } else {
          process.env['BOT_TOKEN'] = savedBotToken;
        }
        resetHomeEnvBootstrapForTesting();
      }
    });

    it('removes channel configs from the scope it reads them from', async () => {
      const userSettingsPath = useRedirectedUserScope({
        $version: 4,
        channels: {
          'user-bot': {
            type: 'management-validation-test',
            clientId: 'user-client',
            clientSecret: 'user-secret',
          },
        },
      });
      try {
        const store = new WorkspaceChannelSettingsStore(workspace);

        const next = await store.remove('user-bot', {
          expectedRevision: store.snapshot().revision,
        });

        expect(next.channels).not.toHaveProperty('user-bot');
        expect(readUserSettings(userSettingsPath).channels).not.toHaveProperty(
          'user-bot',
        );
        // A remove aimed at the workspace scope would still answer with a
        // snapshot that looks empty while the channel and its credentials stay
        // in the file every read path consults.
        expect(readWorkspaceSettings()['channels']).toHaveProperty('bot');
      } finally {
        resetHomeEnvBootstrapForTesting();
      }
    });

    it("keeps a surviving channel's stored secret reference on remove", async () => {
      // A save replaces the whole `channels` subtree, so a remove rewrites every
      // surviving sibling: the write set has to come from the stored form, or the
      // sibling's "$BOT_TOKEN" lands in the user-global file as the resolved
      // plaintext. The variable has to be set for that to be observable at all.
      const userSettingsPath = useRedirectedUserScope({
        $version: 4,
        channels: {
          bot: {
            type: 'management-validation-test',
            clientId: 'client-id',
            clientSecret: '$BOT_TOKEN',
          },
          other: {
            type: 'management-validation-test',
            clientId: 'other-client',
            clientSecret: 'other-secret',
          },
        },
      });
      const savedBotToken = process.env['BOT_TOKEN'];
      process.env['BOT_TOKEN'] = 'sekret-plaintext';
      try {
        const store = new WorkspaceChannelSettingsStore(workspace);

        const next = await store.remove('other', {
          expectedRevision: store.snapshot().revision,
        });

        expect(next.channels).not.toHaveProperty('other');
        expect(
          readUserSettings(userSettingsPath).channels?.['bot']?.[
            'clientSecret'
          ],
        ).toBe('$BOT_TOKEN');
        expect(fs.readFileSync(userSettingsPath, 'utf8')).not.toContain(
          'sekret-plaintext',
        );
      } finally {
        if (savedBotToken === undefined) {
          delete process.env['BOT_TOKEN'];
        } else {
          process.env['BOT_TOKEN'] = savedBotToken;
        }
        resetHomeEnvBootstrapForTesting();
      }
    });

    it('writes the startup channel list to the scope it reads it from', async () => {
      const userSettingsPath = useRedirectedUserScope({
        $version: 4,
        channels: {
          'home-bot': {
            type: 'management-validation-test',
            clientId: 'home-client',
            clientSecret: 'home-secret',
          },
        },
        serve: { channels: [] },
      });
      try {
        const store = new WorkspaceChannelSettingsStore(workspace);

        const next = await store.setStartupNames(['home-bot'], {
          expectedRevision: store.snapshot().revision,
        });

        expect(next.startupNames).toEqual(['home-bot']);
        expect(readUserSettings(userSettingsPath).serve?.channels).toEqual([
          'home-bot',
        ]);
        // Written to the workspace scope instead, the toggle is a silent no-op:
        // nothing reads that file in this layout.
        expect(readWorkspaceSettings()['serve']).not.toHaveProperty('channels');
      } finally {
        resetHomeEnvBootstrapForTesting();
      }
    });
  });
});
