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

const GITHUB: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: [
    {
      key: 'token',
      label: 'Personal Access Token',
      kind: 'secret',
      required: true,
    },
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: true,
      options: [
        { value: 'open', label: 'Open' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
    {
      key: 'senderPolicy',
      label: 'Sender Policy',
      kind: 'enum',
      required: true,
      options: [
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'open', label: 'Open' },
      ],
    },
    {
      key: 'allowedUsers',
      label: 'Allowed Users',
      kind: 'string-list',
    },
  ],
};

describe('Descriptor-driven senderPolicy', () => {
  it('defaults enum fields to the first option for new channels', () => {
    const draft = createChannelEditorDraft(GITHUB);
    expect(draft.values.groupPolicy).toBe('open');
    expect(draft.values.senderPolicy).toBe('allowlist');
    expect(draft.senderPolicy).toBe('');
  });

  it('reads stored enum and string-list values when editing', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        senderPolicy: 'pairing',
        allowedUsers: ['alice', 'bob'],
      },
      secrets: { token: { present: true, source: 'stored' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.values.groupPolicy).toBe('allowlist');
    expect(draft.values.senderPolicy).toBe('pairing');
    expect(draft.values.allowedUsers).toBe('alice, bob');
  });

  it('leaves enum fields empty when editing an instance that lacks them', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'legacy-bot',
      config: { type: 'github' },
      secrets: { token: { present: true, source: 'stored' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.values.groupPolicy).toBe('');
    expect(draft.values.senderPolicy).toBe('');
  });

  it('writes senderPolicy via descriptor fields, not the hardcoded path', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'my-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.allowedUsers = 'alice, bob';

    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1');
    expect(request.config).toEqual({
      type: 'github',
      groupPolicy: 'open',
      senderPolicy: 'allowlist',
      allowedUsers: ['alice', 'bob'],
    });
  });

  it('skips senderPolicy validation when descriptor declares it', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'my-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };

    const errors = validateChannelEditorDraft(GITHUB, draft, []);
    expect(errors).toEqual({});
  });

  it('omits empty string-list fields from the upsert config', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'my-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.allowedUsers = '';

    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1');
    expect(request.config).not.toHaveProperty('allowedUsers');
  });

  it('uses an explicit enum default over the first option for new channels', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'policy',
          label: 'Policy',
          kind: 'enum',
          required: true,
          default: 'disabled',
          options: [
            { value: 'open', label: 'Open' },
            { value: 'disabled', label: 'Disabled' },
          ],
        },
      ],
    };
    const draft = createChannelEditorDraft(descriptor);
    expect(draft.values.policy).toBe('disabled');
  });

  it('flags string-list values outside the declared options', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'reasons',
          label: 'Reasons',
          kind: 'string-list',
          options: [
            { value: 'mention', label: 'mention' },
            { value: 'assign', label: 'assign' },
          ],
        },
      ],
    };

    const valid = createChannelEditorDraft(descriptor);
    valid.name = 'example';
    valid.values.reasons = 'Mention, assign';
    expect(validateChannelEditorDraft(descriptor, valid, [])).toEqual({});

    const invalid = createChannelEditorDraft(descriptor);
    invalid.name = 'example';
    invalid.values.reasons = 'mention, typo';
    expect(validateChannelEditorDraft(descriptor, invalid, [])).toEqual({
      reasons: 'invalidOption',
    });
  });
});
