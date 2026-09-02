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
  createChannelEditorDraft,
  validateChannelEditorDraft,
} from './channel-editor-state';

const DINGTALK: DaemonChannelTypeDescriptor = {
  type: 'dingtalk',
  displayName: 'DingTalk',
  manageable: true,
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
  ],
};

function configuredInstance(): DaemonChannelInstanceSnapshot {
  return {
    name: 'release-bot',
    config: {
      type: 'dingtalk',
      clientId: 'stored-id',
      senderPolicy: 'open',
      sessionScope: 'thread',
      model: 'qwen3-coder-plus',
    },
    secrets: {
      clientSecret: { present: true, source: 'environment' },
    },
    startsWithServe: false,
    runtime: { state: 'stopped' },
  };
}

describe('Channel editor state', () => {
  it('builds a new typed configuration with an explicit secret replacement', () => {
    const draft = createChannelEditorDraft(DINGTALK);
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.secrets.clientSecret = {
      operation: 'replace',
      value: 'ding-client-secret',
    };

    expect(buildChannelUpsertRequest(DINGTALK, draft, 'revision-1')).toEqual({
      expectedRevision: 'revision-1',
      config: {
        type: 'dingtalk',
        clientId: 'ding-client-id',
        senderPolicy: 'pairing',
      },
      secrets: {
        clientSecret: {
          operation: 'replace',
          value: 'ding-client-secret',
        },
      },
    });
  });

  it('preserves hidden public settings and stored secrets when editing', () => {
    const instance = configuredInstance();
    const draft = createChannelEditorDraft(DINGTALK, instance);
    draft.values.clientId = 'updated-id';

    expect(
      buildChannelUpsertRequest(DINGTALK, draft, 'revision-2', instance),
    ).toEqual({
      expectedRevision: 'revision-2',
      config: {
        type: 'dingtalk',
        clientId: 'updated-id',
        senderPolicy: 'open',
        sessionScope: 'thread',
        model: 'qwen3-coder-plus',
      },
      secrets: {
        clientSecret: { operation: 'preserve' },
      },
    });
  });

  it('supports explicitly clearing a stored secret', () => {
    const instance = configuredInstance();
    const draft = createChannelEditorDraft(DINGTALK, instance);
    draft.secrets.clientSecret = { operation: 'clear' };

    expect(
      buildChannelUpsertRequest(DINGTALK, draft, 'revision-3', instance)
        .secrets,
    ).toEqual({
      clientSecret: { operation: 'clear' },
    });
  });

  it('does not change whitespace in a replacement secret', () => {
    const draft = createChannelEditorDraft(DINGTALK);
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.secrets.clientSecret = {
      operation: 'replace',
      value: '  exact-secret  ',
    };

    expect(
      buildChannelUpsertRequest(DINGTALK, draft, 'revision-4').secrets,
    ).toEqual({
      clientSecret: {
        operation: 'replace',
        value: '  exact-secret  ',
      },
    });
  });

  it('requires a unique name, required fields, a replacement secret, and an access policy', () => {
    const draft = createChannelEditorDraft(DINGTALK);
    draft.name = 'existing';
    draft.senderPolicy = '';

    expect(validateChannelEditorDraft(DINGTALK, draft, ['existing'])).toEqual({
      name: 'duplicate',
      clientId: 'required',
      clientSecret: 'required',
      senderPolicy: 'policy',
    });
  });

  it('rejects a non-numeric value for a number field', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'port',
          label: 'Port',
          kind: 'number',
          required: false,
        },
      ],
    };
    const draft = createChannelEditorDraft(descriptor);
    draft.name = 'example';
    draft.values.port = 'not-a-number';

    expect(validateChannelEditorDraft(descriptor, draft, [])).toEqual({
      port: 'number',
    });
  });
});
