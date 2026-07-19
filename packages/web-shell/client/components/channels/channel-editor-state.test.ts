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
});
