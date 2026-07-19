/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  buildChannelUpsertRequest,
  createChannelEditorState,
  updateChannelEditorField,
  updateSecretEditor,
  validateChannelEditor,
} from './channel-editor-state';

const descriptor: DaemonChannelTypeDescriptor = {
  type: 'custom',
  displayName: 'Custom',
  manageable: true,
  auth: ['credentials'],
  fields: [
    { key: 'token', label: 'Token', kind: 'secret', required: true },
    { key: 'retries', label: 'Retries', kind: 'number', required: true },
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    {
      key: 'region',
      label: 'Region',
      kind: 'enum',
      required: true,
      options: [
        { value: 'cn', label: 'China' },
        { value: 'us', label: 'United States' },
      ],
    },
    {
      key: 'endpoint',
      label: 'Endpoint',
      kind: 'string',
      required: true,
      envResolvable: true,
    },
  ],
};

function existing(): DaemonChannelInstanceSnapshot {
  return {
    name: 'ops-bot',
    config: {
      type: 'custom',
      retries: 3,
      enabled: true,
      region: 'cn',
      endpoint: '${BOT_ENDPOINT}',
      pluginFutureField: { keep: true },
      token: 'must-not-enter-the-editor',
    },
    secrets: { token: { present: true, source: 'environment' } },
    webhookSecrets: {},
    startsWithServe: false,
    runtime: { state: 'stopped' },
  };
}

describe('channel editor state', () => {
  it('preserves configured secrets without copying values into state', () => {
    const state = createChannelEditorState({
      catalog: [descriptor],
      instance: existing(),
    });

    expect(state.secrets.token).toEqual({
      operation: 'preserve',
      value: '',
      present: true,
      source: 'environment',
    });
    expect(JSON.stringify(state)).not.toContain('must-not-enter-the-editor');
    expect(buildChannelUpsertRequest(state)).toMatchObject({
      secrets: { token: { operation: 'preserve' } },
    });
  });

  it('never treats an empty replacement as clear', () => {
    const initial = createChannelEditorState({
      catalog: [descriptor],
      instance: existing(),
    });
    const state = updateSecretEditor(initial, 'token', {
      operation: 'replace',
      value: '',
    });

    expect(validateChannelEditor(state)).toContainEqual(
      expect.objectContaining({ field: 'token' }),
    );
    expect(() => buildChannelUpsertRequest(state)).toThrow(
      'Replacement secret is required',
    );
  });

  it('preserves unknown non-secret config while serializing typed fields', () => {
    let state = createChannelEditorState({
      catalog: [descriptor],
      instance: existing(),
      expectedRevision: 'revision-7',
    });
    state = updateChannelEditorField(state, 'retries', '8');
    state = updateChannelEditorField(state, 'enabled', false);
    state = updateChannelEditorField(state, 'region', 'us');

    expect(buildChannelUpsertRequest(state)).toEqual({
      expectedRevision: 'revision-7',
      config: expect.objectContaining({
        type: 'custom',
        retries: 8,
        enabled: false,
        region: 'us',
        pluginFutureField: { keep: true },
      }),
      secrets: { token: { operation: 'preserve' } },
    });
    expect(buildChannelUpsertRequest(state).config).not.toHaveProperty('token');
  });

  it('validates create names with portable server rules including all', () => {
    const invalidNames = ['', 'all', 'ALL', '.', '..', 'a/b', 'con', 'bad.'];
    for (const name of invalidNames) {
      const state = createChannelEditorState({
        catalog: [descriptor],
        name,
      });
      expect(validateChannelEditor(state)).toContainEqual(
        expect.objectContaining({ field: 'name' }),
      );
    }
  });

  it('accepts environment references for required strings and explicit clear', () => {
    const optionalSecretDescriptor = {
      ...descriptor,
      fields: descriptor.fields.map((field) =>
        field.key === 'token' ? { ...field, required: false } : field,
      ),
    };
    let state = createChannelEditorState({
      catalog: [optionalSecretDescriptor],
      instance: existing(),
    });
    state = updateChannelEditorField(state, 'endpoint', '${CUSTOM_ENDPOINT}');
    state = updateSecretEditor(state, 'token', {
      operation: 'clear',
      value: '',
      clearConfirmed: true,
    });

    expect(buildChannelUpsertRequest(state)).toMatchObject({
      config: { endpoint: '${CUSTOM_ENDPOINT}' },
      secrets: { token: { operation: 'clear' } },
    });
  });

  it('allows absent required credentials only through advertised QR auth', () => {
    const qrDescriptor = {
      ...descriptor,
      auth: ['credentials', 'qr'] as const,
    };
    let state = createChannelEditorState({
      catalog: [qrDescriptor],
      name: 'bot',
    });
    expect(validateChannelEditor(state)).toContainEqual(
      expect.objectContaining({ field: 'token' }),
    );

    state = { ...state, authMethod: 'qr' };
    expect(validateChannelEditor(state)).not.toContainEqual(
      expect.objectContaining({ field: 'token' }),
    );
  });

  it('sanitizes webhook literals and preserves them through explicit intent', () => {
    const webhookSecret = 'webhook-secret-sentinel';
    const instance = existing();
    instance.config.webhooks = {
      sources: {
        github: {
          secret: webhookSecret,
          targets: { main: { chatId: 'chat-1' } },
        },
      },
    };
    instance.webhookSecrets = {
      github: { present: true, source: 'literal' },
    };

    const state = createChannelEditorState({
      catalog: [descriptor],
      instance,
      expectedRevision: 'revision-8',
    });
    const request = buildChannelUpsertRequest(state);

    expect(JSON.stringify(state)).not.toContain(webhookSecret);
    expect(state.values.webhooks).not.toContain(webhookSecret);
    expect(JSON.stringify(request.config)).not.toContain(webhookSecret);
    expect(request.webhookSecrets).toEqual({
      github: { operation: 'preserve' },
    });
  });

  it('shapes webhook replace, invalid clear, and environment switch intents', () => {
    const instance = existing();
    instance.config.webhooks = {
      sources: { github: { targets: {} } },
    };
    instance.webhookSecrets = {
      github: { present: true, source: 'literal' },
    };
    let state = createChannelEditorState({
      catalog: [descriptor],
      instance,
    });
    state = updateSecretEditor(state, 'webhook:github', {
      operation: 'replace',
      value: 'replacement-secret',
    });
    expect(buildChannelUpsertRequest(state).webhookSecrets).toEqual({
      github: { operation: 'replace', value: 'replacement-secret' },
    });

    state = updateSecretEditor(state, 'webhook:github', {
      operation: 'clear',
      value: '',
      clearConfirmed: true,
    });
    expect(validateChannelEditor(state)).toContainEqual(
      expect.objectContaining({ field: 'webhook:github' }),
    );

    state = updateChannelEditorField(
      state,
      'webhooks',
      JSON.stringify({
        sources: {
          github: { secretEnv: 'GITHUB_WEBHOOK_SECRET', targets: {} },
        },
      }),
    );
    expect(validateChannelEditor(state)).not.toContainEqual(
      expect.objectContaining({ field: 'webhook:github' }),
    );
    expect(buildChannelUpsertRequest(state).webhookSecrets).toEqual({
      github: { operation: 'clear' },
    });
  });

  it('treats QQ appSecret as an explicit secret intent', () => {
    const qqDescriptor: DaemonChannelTypeDescriptor = {
      type: 'qq',
      displayName: 'QQ',
      manageable: true,
      auth: ['credentials', 'qr'],
      fields: [
        { key: 'appID', label: 'App ID', kind: 'string' },
        { key: 'appSecret', label: 'App Secret', kind: 'secret' },
      ],
    };
    const secret = 'qq-app-secret-sentinel';
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'qq-bot',
      config: { type: 'qq', appID: 'id', appSecret: secret },
      secrets: { appSecret: { present: true, source: 'literal' } },
      webhookSecrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };

    const state = createChannelEditorState({
      catalog: [qqDescriptor],
      instance,
    });

    expect(JSON.stringify(state)).not.toContain(secret);
    expect(buildChannelUpsertRequest(state)).toMatchObject({
      config: { type: 'qq', appID: 'id' },
      secrets: { appSecret: { operation: 'preserve' } },
    });
  });

  it('requires explicit replacement for a new literal webhook source', () => {
    let state = createChannelEditorState({
      catalog: [descriptor],
      instance: existing(),
    });
    state = updateChannelEditorField(
      state,
      'webhooks',
      JSON.stringify({ sources: { deploy: { targets: {} } } }),
    );
    expect(validateChannelEditor(state)).toContainEqual(
      expect.objectContaining({ field: 'webhook:deploy' }),
    );

    state = updateSecretEditor(state, 'webhook:deploy', {
      operation: 'replace',
      value: 'new-source-secret',
    });
    expect(buildChannelUpsertRequest(state).webhookSecrets).toEqual({
      deploy: { operation: 'replace', value: 'new-source-secret' },
    });
  });

  it('requires replacement when an environment webhook becomes literal', () => {
    const instance = existing();
    instance.config.webhooks = {
      sources: {
        github: { secretEnv: 'GITHUB_WEBHOOK_SECRET', targets: {} },
      },
    };
    instance.webhookSecrets = {
      github: { present: true, source: 'environment' },
    };
    let state = createChannelEditorState({ catalog: [descriptor], instance });

    state = updateChannelEditorField(
      state,
      'webhooks',
      JSON.stringify({ sources: { github: { targets: {} } } }),
    );
    expect(validateChannelEditor(state)).toContainEqual({
      field: 'webhook:github',
      message: 'Enter a replacement webhook secret or restore secretEnv.',
    });

    state = updateSecretEditor(state, 'webhook:github', {
      operation: 'replace',
      value: 'literal-replacement',
    });
    expect(buildChannelUpsertRequest(state).webhookSecrets).toEqual({
      github: { operation: 'replace', value: 'literal-replacement' },
    });

    state = updateChannelEditorField(
      createChannelEditorState({ catalog: [descriptor], instance }),
      'webhooks',
      JSON.stringify({
        sources: {
          github: { secretEnv: 'RESTORED_WEBHOOK_SECRET', targets: {} },
        },
      }),
    );
    expect(validateChannelEditor(state)).not.toContainEqual(
      expect.objectContaining({ field: 'webhook:github' }),
    );
    expect(buildChannelUpsertRequest(state).webhookSecrets).toEqual({
      github: { operation: 'preserve' },
    });
  });
});
