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
  repositoryAllowlistIds,
  validateChannelEditorDraft,
} from './channel-editor-state';
import type { ChannelGroupOverrideDraft } from './channel-editor-state';

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
    {
      key: 'sessionScope',
      label: 'Session scope',
      kind: 'enum',
      required: true,
      default: 'user',
      options: [
        { value: 'user', label: 'Per user and chat' },
        { value: 'thread', label: 'Per thread' },
        { value: 'chat_thread', label: 'Per chat and thread' },
        { value: 'single', label: 'One shared session' },
      ],
    },
    {
      key: 'interactiveCards',
      label: 'Interactive Cards',
      kind: 'object',
      properties: [{ key: 'enabled', label: 'Enabled', kind: 'boolean' }],
    },
  ],
};

const DINGTALK_WITH_ACCESS: DaemonChannelTypeDescriptor = {
  ...DINGTALK,
  fields: [
    ...DINGTALK.fields,
    {
      key: 'privatePolicy',
      label: 'Private Policy',
      kind: 'enum',
      required: true,
      default: 'pairing',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
    },
    {
      key: 'allowedUsers',
      label: 'Allowed Users',
      kind: 'string-list',
    },
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: true,
      default: 'disabled',
      options: [
        { value: 'disabled', label: 'Disabled' },
        { value: 'pairing', label: 'Pairing' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'open', label: 'Open' },
      ],
    },
  ],
};

const DINGTALK_WITH_OUTPUT: DaemonChannelTypeDescriptor = {
  ...DINGTALK,
  fields: [
    ...DINGTALK.fields,
    {
      key: 'outputMode',
      label: 'Output Mode',
      kind: 'enum',
      default: 'per_turn',
      options: [
        { value: 'per_task', label: 'Per task' },
        { value: 'per_response', label: 'Per response' },
        { value: 'per_turn', label: 'Per turn (default)' },
      ],
    },
  ],
};

function configuredInstance(): DaemonChannelInstanceSnapshot {
  return {
    name: 'release-bot',
    config: {
      type: 'dingtalk',
      clientId: 'stored-id',
      privatePolicy: 'open',
      sessionScope: 'thread',
      model: 'qwen3-coder-plus',
      interactiveCards: {
        enabled: true,
        statusCard: { enabled: true },
      },
    },
    secrets: {
      clientSecret: { present: true, source: 'environment' },
    },
    startsWithServe: false,
    runtime: { state: 'stopped' },
  };
}

describe('Channel editor state', () => {
  it.each([false, true])(
    'selects the per-turn default for an unconfigured output mode (editing=%s)',
    (editing) => {
      const instance = editing ? configuredInstance() : undefined;
      const draft = createChannelEditorDraft(DINGTALK_WITH_OUTPUT, instance);

      expect(draft.values.outputMode).toBe('per_turn');
      expect(
        buildChannelUpsertRequest(
          DINGTALK_WITH_OUTPUT,
          draft,
          'revision-output',
          instance,
        ).config.outputMode,
      ).toBe('per_turn');
    },
  );

  it.each(['per_task', 'per_response', 'per_turn'])(
    'preserves explicitly configured output mode %s',
    (outputMode) => {
      const instance = configuredInstance();
      instance.config.outputMode = outputMode;
      const draft = createChannelEditorDraft(DINGTALK_WITH_OUTPUT, instance);

      expect(draft.values.outputMode).toBe(outputMode);
      expect(
        buildChannelUpsertRequest(
          DINGTALK_WITH_OUTPUT,
          draft,
          'revision-output',
          instance,
        ).config.outputMode,
      ).toBe(outputMode);
    },
  );

  it('does not add output mode to descriptors that do not support it', () => {
    const instance = configuredInstance();
    const draft = createChannelEditorDraft(DINGTALK, instance);

    expect(draft.values).not.toHaveProperty('outputMode');
    expect(
      buildChannelUpsertRequest(DINGTALK, draft, 'revision-output', instance)
        .config,
    ).not.toHaveProperty('outputMode');
  });

  it('keeps unrelated optional enums unset when editing', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK_WITH_OUTPUT,
      fields: [
        ...DINGTALK_WITH_OUTPUT.fields,
        {
          key: 'customMode',
          label: 'Custom Mode',
          kind: 'enum',
          default: 'safe',
          options: [{ value: 'safe', label: 'Safe' }],
        },
      ],
    };
    const instance = configuredInstance();
    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.outputMode).toBe('per_turn');
    expect(draft.values.customMode).toBe('');
    expect(
      buildChannelUpsertRequest(descriptor, draft, 'revision-output', instance)
        .config,
    ).not.toHaveProperty('customMode');
  });

  it.each([
    [{}, 'allowlist'],
    [{ senderPolicy: 'pairing' }, 'pairing'],
    [{ senderPolicy: 'open', dmPolicy: 'disabled' }, 'disabled'],
    [
      {
        privatePolicy: 'open',
        senderPolicy: 'allowlist',
        dmPolicy: 'disabled',
      },
      'open',
    ],
  ])(
    'reads private access from %j and preserves deprecated keys on save',
    (legacy, expected) => {
      const instance = configuredInstance();
      instance.config = { type: 'dingtalk', ...legacy };
      const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
      expect(draft.values.privatePolicy).toBe(expected);
      expect(createChannelEditorDraft(DINGTALK, instance).privatePolicy).toBe(
        expected,
      );
      const request = buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-1',
        instance,
      );
      expect(request.config).toMatchObject({
        ...legacy,
        privatePolicy: expected,
      });
    },
  );

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
        sessionScope: 'user',
        privatePolicy: 'pairing',
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
        privatePolicy: 'open',
        sessionScope: 'thread',
        model: 'qwen3-coder-plus',
        interactiveCards: {
          enabled: true,
          statusCard: { enabled: true },
        },
      },
      secrets: {
        clientSecret: { operation: 'preserve' },
      },
    });
  });

  it('serializes sender and group allowlists in the runtime config shapes', () => {
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS) as ReturnType<
      typeof createChannelEditorDraft
    > & { allowedGroupIds?: string };
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.values.privatePolicy = 'allowlist';
    draft.values.allowedUsers = 'staff-a, staff-b';
    draft.values.groupPolicy = 'allowlist';
    draft.values.sessionScope = 'chat_thread';
    draft.allowedGroupIds = 'group-a, group-b';
    draft.secrets.clientSecret = {
      operation: 'replace',
      value: 'ding-client-secret',
    };

    expect(
      buildChannelUpsertRequest(DINGTALK_WITH_ACCESS, draft, 'revision-access')
        .config,
    ).toEqual({
      type: 'dingtalk',
      clientId: 'ding-client-id',
      privatePolicy: 'allowlist',
      allowedUsers: ['staff-a', 'staff-b'],
      groupPolicy: 'allowlist',
      sessionScope: 'chat_thread',
      groups: {
        'group-a': {},
        'group-b': {},
      },
    });
  });

  it('preserves the deprecated thread scope when editing', () => {
    const instance = configuredInstance();

    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);

    expect(draft.values.sessionScope).toBe('thread');
    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-session-scope',
        instance,
      ).config.sessionScope,
    ).toBe('thread');
  });

  it('uses chat_thread for a new Channel whose plugin default is legacy thread', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope' ? { ...field, default: 'thread' } : field,
      ),
    };

    const draft = createChannelEditorDraft(descriptor);

    expect(draft.values.sessionScope).toBe('chat_thread');
  });

  it('uses a visible scope for a new Channel without chat_thread support', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope'
          ? {
              ...field,
              default: 'thread',
              options: field.options?.filter(
                (option) => option.value !== 'chat_thread',
              ),
            }
          : field,
      ),
    };

    const draft = createChannelEditorDraft(descriptor);

    expect(draft.values.sessionScope).toBe('user');
  });

  it('preserves an inherited legacy thread default when editing', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope' ? { ...field, default: 'thread' } : field,
      ),
    };
    const instance = configuredInstance();
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.sessionScope).toBe('thread');
    expect(
      buildChannelUpsertRequest(
        descriptor,
        draft,
        'revision-session-scope',
        instance,
      ).config.sessionScope,
    ).toBe('thread');
  });

  const chatThreadDefaultDescriptor = (): DaemonChannelTypeDescriptor => ({
    ...DINGTALK,
    fields: DINGTALK.fields.map((field) =>
      field.key === 'sessionScope'
        ? { ...field, default: 'chat_thread' }
        : field,
    ),
  });

  it('pre-fills user for a multiSession instance whose plugin default is non-user', () => {
    const descriptor = chatThreadDefaultDescriptor();
    const instance = configuredInstance();
    instance.config.multiSession = true;
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(descriptor, instance);

    // A multiSession channel only runs scope 'user'; submitting the plugin's
    // 'chat_thread' default would make the store reject every save.
    expect(draft.values.sessionScope).toBe('user');
    expect(
      buildChannelUpsertRequest(
        descriptor,
        draft,
        'revision-multi-session',
        instance,
      ).config.sessionScope,
    ).toBe('user');
  });

  it('preserves a non-user default for an instance without multiSession', () => {
    const descriptor = chatThreadDefaultDescriptor();
    const instance = configuredInstance();
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.sessionScope).toBe('chat_thread');
  });

  it('pre-fills user for a multiSession instance whose plugin default is legacy thread', () => {
    // The legacy `field.default === 'thread'` branch below returns 'thread'
    // for an existing instance, which the store rejects for multiSession —
    // this is the QQ plugin's own shape.
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope' ? { ...field, default: 'thread' } : field,
      ),
    };
    const instance = configuredInstance();
    instance.config.multiSession = true;
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.sessionScope).toBe('user');
    expect(
      buildChannelUpsertRequest(
        descriptor,
        draft,
        'revision-multi-session-thread',
        instance,
      ).config.sessionScope,
    ).toBe('user');
  });

  it('pre-fills user for a multiSession instance whose sessionScope field has no default', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK,
      fields: DINGTALK.fields.map((field) =>
        field.key === 'sessionScope' ? { ...field, default: undefined } : field,
      ),
    };
    const instance = configuredInstance();
    instance.config.multiSession = true;
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.sessionScope).toBe('user');
  });

  it('keeps an explicit non-user scope so the store still rejects it', () => {
    const descriptor = chatThreadDefaultDescriptor();
    const instance = configuredInstance();
    instance.config.multiSession = true;
    instance.config.sessionScope = 'chat_thread';

    const draft = createChannelEditorDraft(descriptor, instance);

    // Not pre-fill: the stored value is explicit, so the editor must not
    // silently rewrite it; the store's compatibility check rejects the save.
    expect(draft.values.sessionScope).toBe('chat_thread');
  });

  it('fills safe policy defaults when editing a legacy instance', () => {
    const instance = configuredInstance();
    delete instance.config.privatePolicy;

    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);

    expect(draft.values.privatePolicy).toBe('allowlist');
    expect(draft.values.groupPolicy).toBe('disabled');
    expect(validateChannelEditorDraft(DINGTALK_WITH_ACCESS, draft, [])).toEqual(
      {},
    );
  });

  it('changes group allowlist membership without losing wildcard or retained group settings', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        privatePolicy: 'allowlist',
        allowedUsers: ['staff-a'],
        groupPolicy: 'allowlist',
        groups: {
          '*': { requireMention: false },
          'group-a': { dispatchMode: 'collect' },
          'group-removed': { requireMention: true },
        },
      },
    };
    const draft = createChannelEditorDraft(
      DINGTALK_WITH_ACCESS,
      instance,
    ) as ReturnType<typeof createChannelEditorDraft> & {
      allowedGroupIds?: string;
    };

    expect(draft.allowedGroupIds).toBe('group-a, group-removed');
    draft.allowedGroupIds = 'group-a, group-new';

    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-groups',
        instance,
      ).config.groups,
    ).toEqual({
      '*': { requireMention: false },
      'group-a': { dispatchMode: 'collect' },
      'group-new': {},
    });
  });

  it('leaves an unset group senders default out of the saved config', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        groupPolicy: 'open',
        groups: { '*': { requireMention: false } },
      },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);

    expect(draft.groupSenders).toBe('');
    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-senders',
        instance,
      ).config.groups,
    ).toEqual({ '*': { requireMention: false } });
  });

  it('writes the chosen group senders into groups["*"] beside its other settings', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        groupPolicy: 'open',
        groups: {
          '*': { requireMention: false },
          ops: { senders: 'open' },
        },
      },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
    draft.groupSenders = 'allowlist';
    draft.groupAllowedUsers = 'alice, bob, alice';

    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-senders',
        instance,
      ).config.groups,
    ).toEqual({
      '*': {
        requireMention: false,
        senders: 'allowlist',
        allowedUsers: ['alice', 'bob'],
      },
      ops: { senders: 'open' },
    });
  });

  it('round-trips configured group senders and their member list', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        groupPolicy: 'open',
        groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
      },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);

    expect(draft.groupSenders).toBe('allowlist');
    expect(draft.groupAllowedUsers).toBe('alice');
    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-senders',
        instance,
      ).config.groups,
    ).toEqual({ '*': { senders: 'allowlist', allowedUsers: ['alice'] } });
  });

  it('keeps an explicitly empty list instead of widening it to unset', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...DINGTALK_WITH_ACCESS,
      fields: [
        ...DINGTALK_WITH_ACCESS.fields,
        { key: 'operators', label: 'Session Operators', kind: 'string-list' },
      ],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: { ...configuredInstance().config, operators: [] },
    };
    const draft = createChannelEditorDraft(descriptor, instance);

    expect(draft.values.operators).toBe('');
    expect(
      buildChannelUpsertRequest(descriptor, draft, 'revision-ops', instance)
        .config.operators,
    ).toEqual([]);

    draft.values.operators = 'admin';
    expect(
      buildChannelUpsertRequest(descriptor, draft, 'revision-ops', instance)
        .config.operators,
    ).toEqual(['admin']);
  });

  it('rejects unsafe group allowlist keys before building the request', () => {
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS);
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.values.privatePolicy = 'allowlist';
    draft.values.groupPolicy = 'allowlist';
    draft.allowedGroupIds = '__proto__';
    draft.secrets.clientSecret = {
      operation: 'replace',
      value: 'ding-client-secret',
    };

    expect(
      validateChannelEditorDraft(DINGTALK_WITH_ACCESS, draft, []),
    ).toMatchObject({ allowedGroupIds: 'invalidGroupId' });
  });

  it('ignores a hidden group allowlist outside allowlist policy', () => {
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS);
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.values.privatePolicy = 'allowlist';
    draft.values.groupPolicy = 'open';
    draft.allowedGroupIds = '__proto__';
    draft.secrets.clientSecret = {
      operation: 'replace',
      value: 'ding-client-secret',
    };

    expect(validateChannelEditorDraft(DINGTALK_WITH_ACCESS, draft, [])).toEqual(
      {},
    );
    expect(
      buildChannelUpsertRequest(DINGTALK_WITH_ACCESS, draft, 'revision-open')
        .config,
    ).not.toHaveProperty('groups');
  });

  it('removes allowlist-only groups but keeps behavior settings when leaving allowlist', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        groupPolicy: 'allowlist',
        groups: {
          '*': { requireMention: false },
          'group-a': {},
          'group-b': { requireMention: true },
          'group-c': { dispatchMode: 'collect', groupHistoryLimit: 25 },
        },
      },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
    draft.values.groupPolicy = 'open';

    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-open',
        instance,
      ).config.groups,
    ).toEqual({
      '*': { requireMention: false },
      'group-b': { requireMention: true },
      'group-c': { dispatchMode: 'collect', groupHistoryLimit: 25 },
    });
  });

  it('preserves stored group settings for an unchanged non-allowlist policy', () => {
    const groups = {
      '*': { requireMention: false },
      'group-a': { dispatchMode: 'collect', groupHistoryLimit: 25 },
    };
    const instance: DaemonChannelInstanceSnapshot = {
      ...configuredInstance(),
      config: {
        ...configuredInstance().config,
        groupPolicy: 'pairing',
        groups,
      },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
    draft.values.clientId = 'updated-id';

    expect(
      buildChannelUpsertRequest(
        DINGTALK_WITH_ACCESS,
        draft,
        'revision-pairing',
        instance,
      ).config.groups,
    ).toEqual(groups);
  });

  it('shows the effective scope default for a legacy instance', () => {
    const instance = configuredInstance();
    delete instance.config.sessionScope;

    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);

    expect(draft.values.sessionScope).toBe('user');
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

  it('does not clear a required secret from a blank replacement', () => {
    const draft = createChannelEditorDraft(DINGTALK);
    draft.name = 'release-bot';
    draft.values.clientId = 'ding-client-id';
    draft.secrets.clientSecret = { operation: 'replace', value: ' ' };

    expect(
      buildChannelUpsertRequest(DINGTALK, draft, 'revision-5').secrets,
    ).toEqual({
      clientSecret: { operation: 'replace', value: ' ' },
    });
  });

  it('requires a unique name, required fields, a replacement secret, and an access policy', () => {
    const draft = createChannelEditorDraft(DINGTALK);
    draft.name = 'existing';
    draft.privatePolicy = '';

    expect(validateChannelEditorDraft(DINGTALK, draft, ['existing'])).toEqual({
      name: 'duplicate',
      clientId: 'required',
      clientSecret: 'required',
      privatePolicy: 'policy',
    });
  });

  it('keeps object fields out of the editor draft', () => {
    const draft = createChannelEditorDraft(DINGTALK, configuredInstance());
    expect(draft.values).not.toHaveProperty('interactiveCards');
  });

  it('ignores object fields during validation even when marked required', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'interactiveCards',
          label: 'Interactive Cards',
          kind: 'object',
          required: true,
        },
      ] as unknown as DaemonChannelTypeDescriptor['fields'],
    };

    const draft = createChannelEditorDraft(descriptor);
    draft.name = 'example';
    draft.values.interactiveCards = '';

    expect(validateChannelEditorDraft(descriptor, draft, [])).toEqual({});
  });

  it('rejects number values at or below the exclusive minimum', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'timeoutMs',
          label: 'Timeout (ms)',
          kind: 'number',
          exclusiveMinimum: 0,
        },
      ],
    };

    const invalid = createChannelEditorDraft(descriptor);
    invalid.name = 'example';
    invalid.values.timeoutMs = '0';
    expect(validateChannelEditorDraft(descriptor, invalid, [])).toEqual({
      timeoutMs: 'outOfRange',
    });

    const valid = createChannelEditorDraft(descriptor);
    valid.name = 'example';
    valid.values.timeoutMs = '270000';
    expect(validateChannelEditorDraft(descriptor, valid, [])).toEqual({});
  });

  it('treats a whitespace-only number draft as empty instead of invalid', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      type: 'example',
      displayName: 'Example',
      manageable: true,
      fields: [
        {
          key: 'timeoutMs',
          label: 'Timeout (ms)',
          kind: 'number',
          exclusiveMinimum: 0,
        },
      ],
    };

    const draft = createChannelEditorDraft(descriptor);
    draft.name = 'example';
    draft.values.timeoutMs = '   ';

    expect(validateChannelEditorDraft(descriptor, draft, [])).toEqual({});
    expect(
      buildChannelUpsertRequest(descriptor, draft, 'revision-1').config,
    ).toEqual({ type: 'example', privatePolicy: 'pairing' });
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
    },
    {
      key: 'useLocalGh',
      label: 'Use Local GitHub CLI Authentication',
      kind: 'boolean',
    },
    {
      key: 'groupPolicy',
      label: 'Group Policy',
      kind: 'enum',
      required: true,
      default: 'open',
      options: [
        { value: 'open', label: 'Open' },
        { value: 'allowlist', label: 'Allowlist' },
        { value: 'disabled', label: 'Disabled' },
      ],
    },
    {
      key: 'privatePolicy',
      label: 'Private Policy',
      kind: 'enum',
      required: true,
      default: 'allowlist',
      options: [
        { value: 'disabled', label: 'Disabled' },
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

describe('Descriptor-driven privatePolicy', () => {
  it('defaults enum fields to the first option for new channels', () => {
    const draft = createChannelEditorDraft(GITHUB);
    expect(draft.values.groupPolicy).toBe('open');
    expect(draft.values.privatePolicy).toBe('allowlist');
    expect(draft.privatePolicy).toBe('');
  });

  it('reads stored enum and string-list values when editing', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        privatePolicy: 'pairing',
        allowedUsers: ['alice', 'bob'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.values.groupPolicy).toBe('allowlist');
    expect(draft.values.privatePolicy).toBe('pairing');
    expect(draft.values.allowedUsers).toBe('alice, bob');
  });

  it('uses runtime policy fallbacks when editing an instance that lacks them', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'legacy-bot',
      config: { type: 'github' },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.values.groupPolicy).toBe('disabled');
    expect(draft.values.privatePolicy).toBe('allowlist');
  });

  it('writes privatePolicy via descriptor fields, not the hardcoded path', () => {
    const descriptor: DaemonChannelTypeDescriptor = {
      ...GITHUB,
      type: 'dws',
      displayName: 'DWS',
    };
    const draft = createChannelEditorDraft(descriptor);
    draft.name = 'my-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.allowedUsers = 'alice, bob';

    const request = buildChannelUpsertRequest(descriptor, draft, 'rev-1');
    expect(request.config).toEqual({
      type: 'dws',
      useLocalGh: false,
      groupPolicy: 'open',
      privatePolicy: 'allowlist',
      allowedUsers: ['alice', 'bob'],
    });
  });

  it('requires a token or explicit local gh authentication', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'my-bot';

    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({
      token: 'credential',
    });
  });

  it('allows a new GitHub channel to opt into local gh authentication', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'my-bot';
    draft.values.useLocalGh = true;
    draft.secrets.token = { operation: 'replace', value: '  ' };

    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({});
    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1');
    expect(request.config).toMatchObject({ useLocalGh: true });
    expect(request.secrets).toEqual({ token: { operation: 'clear' } });
  });

  it('round-trips useLocalGh from an existing channel draft', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        useLocalGh: true,
        groupPolicy: 'open',
        privatePolicy: 'allowlist',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.values.useLocalGh).toBe(true);
    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1', instance);
    expect(request.config).toMatchObject({ useLocalGh: true });
  });

  it('clears an existing optional secret from a blank replacement', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        useLocalGh: true,
        groupPolicy: 'open',
        privatePolicy: 'allowlist',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.secrets.token = { operation: 'replace', value: '  ' };

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).secrets,
    ).toEqual({ token: { operation: 'clear' } });
  });

  it('replaces an existing optional secret with a non-blank value', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        useLocalGh: true,
        groupPolicy: 'open',
        privatePolicy: 'allowlist',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.secrets.token = { operation: 'replace', value: 'ghp_new' };

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-6', instance).secrets,
    ).toEqual({ token: { operation: 'replace', value: 'ghp_new' } });
  });

  it('keeps an unchanged stored token valid while editing an existing channel', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        privatePolicy: 'allowlist',
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({});
  });

  it('skips privatePolicy validation when descriptor declares it', () => {
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

// The registry injects privatePolicy/allowedUsers into every manageable
// channel, but GitHub traffic is always group traffic, so the adapter never
// reads them and group IDs are repository full names.
describe('Repository-only channel access config', () => {
  it('does not persist the direct-message policy', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.allowedUsers = 'alice';

    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1');
    expect(request.config).toEqual({
      type: 'github',
      useLocalGh: false,
      groupPolicy: 'open',
    });
  });

  it('drops the private-access residue stored by an earlier save', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: 'open',
        privatePolicy: 'pairing',
        allowedUsers: ['alice'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);

    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance);
    expect(request.config).not.toHaveProperty('privatePolicy');
    expect(request.config).not.toHaveProperty('allowedUsers');
  });

  it('requires owner/repo for an allowlisted repository', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.groupPolicy = 'allowlist';
    draft.allowedGroupIds = 'qwen-code';

    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({
      allowedGroupIds: 'invalidRepoId',
    });

    draft.allowedGroupIds = 'QwenLM/qwen-code, acme/widgets.js';
    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({});
  });

  it('stores repository allowlists under the canonical lower-case key', () => {
    // The adapter matches the canonical `owner/repo` GitHub reports, so the
    // editor must not certify a spelling that never matches at runtime.
    for (const typed of ['qwenlm/qwen-code', 'QwenLM/Qwen-Code']) {
      const draft = createChannelEditorDraft(GITHUB);
      draft.name = 'release-bot';
      draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
      draft.values.groupPolicy = 'allowlist';
      draft.allowedGroupIds = typed;

      const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-1');
      expect(Object.keys(request.config['groups'] as object)).toEqual([
        'qwenlm/qwen-code',
      ]);
    }
  });

  it('refuses to save when stored repository aliases carry different settings', () => {
    // Both spellings are one repository to GitHub, but the runtime resolves an
    // exact key first. Collapsing them would keep the empty entry and drop the
    // sender restriction on a save the operator meant as a no-op.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          'QwenLM/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
          'qwenlm/qwen-code': {},
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(draft.allowedGroupIds).toBe('qwenlm/qwen-code');
    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({
      allowedGroupIds: 'conflictingRepoAliases',
    });
  });

  it('collapses repository aliases that carry identical settings', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          'QwenLM/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
          'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({});
    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance);
    expect(request.config['groups']).toEqual({
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
  });

  it('treats aliases that differ only in key or allowlist order as identical', () => {
    // Neither ordering carries meaning, so reporting a conflict here would
    // block an unrelated save with a message that does not match the reason.
    const orderings: Array<[Record<string, unknown>, Record<string, unknown>]> =
      [
        [
          { senders: 'allowlist', requireMention: true },
          { requireMention: true, senders: 'allowlist' },
        ],
        [
          { senders: 'allowlist', allowedUsers: ['alice', 'bob'] },
          { senders: 'allowlist', allowedUsers: ['bob', 'alice'] },
        ],
      ];
    for (const [first, second] of orderings) {
      const instance: DaemonChannelInstanceSnapshot = {
        name: 'release-bot',
        config: {
          type: 'github',
          groupPolicy: 'allowlist',
          groups: { 'QwenLM/qwen-code': first, 'qwenlm/qwen-code': second },
        },
        secrets: { token: { present: true, source: 'literal' } },
        startsWithServe: false,
        runtime: { state: 'stopped' },
      };
      const draft = createChannelEditorDraft(GITHUB, instance);

      expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual(
        {},
      );
      const request = buildChannelUpsertRequest(
        GITHUB,
        draft,
        'rev-2',
        instance,
      );
      expect(Object.keys(request.config['groups'] as object)).toEqual([
        'qwenlm/qwen-code',
      ]);
    }
  });

  it('keeps per-repository settings when the allowlist case changes', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          'QwenLM/qwen-code': {
            senders: 'allowlist',
            allowedUsers: ['alice'],
          },
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    expect(draft.allowedGroupIds).toBe('qwenlm/qwen-code');

    const request = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance);
    expect(request.config['groups']).toEqual({
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
  });

  it('drops a stored token once local gh authentication is selected', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: { type: 'github', useLocalGh: true, groupPolicy: 'open' },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };

    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(draft.secrets.token).toEqual({ operation: 'clear' });
    expect(buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)).toEqual(
      expect.objectContaining({
        secrets: { token: { operation: 'clear' } },
      }),
    );
  });
});

describe('Per-repository overrides', () => {
  function githubInstance(
    groups: Record<string, unknown>,
  ): DaemonChannelInstanceSnapshot {
    return {
      name: 'release-bot',
      config: { type: 'github', groupPolicy: 'allowlist', groups },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
  }

  function draftFor(
    instance: DaemonChannelInstanceSnapshot,
    allowedGroupIds = 'qwenlm/qwen-code',
  ) {
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.allowedGroupIds = allowedGroupIds;
    return draft;
  }

  it('reads a stored override into the draft', () => {
    const instance = githubInstance({
      '*': { senders: 'open' },
      'qwenlm/qwen-code': {
        requireMention: false,
        senders: 'allowlist',
        allowedUsers: ['alice', 'bob'],
      },
    });

    expect(draftFor(instance).groupOverrides).toEqual({
      'qwenlm/qwen-code': {
        requireMention: 'false',
        senders: 'allowlist',
        allowedUsers: 'alice, bob',
      },
    });
  });

  it('keys the draft overrides by the canonical repository id', () => {
    // The rows are looked up by the canonical id the allowlist produces, so a
    // mixed-case stored key must not leave its own row showing "inherit".
    const instance = githubInstance({
      'QwenLM/Qwen-Code': { requireMention: false },
    });

    expect(Object.keys(draftFor(instance).groupOverrides)).toEqual([
      'qwenlm/qwen-code',
    ]);
  });

  it('reads an absent key as inherit rather than as the resolved default', () => {
    const instance = githubInstance({
      '*': { requireMention: false, senders: 'allowlist' },
      'qwenlm/qwen-code': {},
    });

    expect(draftFor(instance).groupOverrides['qwenlm/qwen-code']).toEqual({
      requireMention: '',
      senders: '',
      allowedUsers: '',
    });
  });

  it('round-trips an untouched channel without materializing inherited values', () => {
    // Writing the resolved default into every repository would freeze today's
    // inheritance and stop a later change to "*" from reaching them.
    const groups = {
      '*': {
        requireMention: false,
        senders: 'allowlist',
        allowedUsers: ['op'],
      },
      'qwenlm/qwen-code': {},
      'acme/widgets': { dispatchMode: 'collect', groupHistoryLimit: 25 },
    };
    // Clone into the instance: comparing against the same reference would let
    // an in-place mutation of the stored config satisfy the assertion.
    const instance = githubInstance(structuredClone(groups));

    const request = buildChannelUpsertRequest(
      GITHUB,
      draftFor(instance, 'qwenlm/qwen-code, acme/widgets'),
      'rev-2',
      instance,
    );

    expect(request.config['groups']).toEqual(groups);
  });

  it('keeps shapes the form cannot express when nothing was edited', () => {
    // An empty allowlist means "nobody", and a list with no policy beside it
    // inherits the policy but overrides the members. Neither may be normalized
    // away by a save the operator meant as a no-op.
    const groups = {
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: [] },
      'acme/widgets': { allowedUsers: ['alice'] },
    };
    const instance = githubInstance(structuredClone(groups));

    const request = buildChannelUpsertRequest(
      GITHUB,
      draftFor(instance, 'qwenlm/qwen-code, acme/widgets'),
      'rev-2',
      instance,
    );

    expect(request.config['groups']).toEqual(groups);
  });

  it('writes an explicit require-mention as a boolean and deletes it on inherit', () => {
    const instance = githubInstance({ 'qwenlm/qwen-code': {} });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].requireMention = 'false';
    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ 'qwenlm/qwen-code': { requireMention: false } });

    draft.groupOverrides['qwenlm/qwen-code'].requireMention = 'true';
    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ 'qwenlm/qwen-code': { requireMention: true } });

    draft.groupOverrides['qwenlm/qwen-code'].requireMention = '';
    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ 'qwenlm/qwen-code': {} });
  });

  it('writes an explicit speaker allowlist as a string array', () => {
    const instance = githubInstance({ 'qwenlm/qwen-code': {} });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].senders = 'allowlist';
    draft.groupOverrides['qwenlm/qwen-code'].allowedUsers = 'alice, bob';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      'qwenlm/qwen-code': {
        senders: 'allowlist',
        allowedUsers: ['alice', 'bob'],
      },
    });
  });

  it('treats an emptied explicit allowlist as nobody, not as inherit', () => {
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].allowedUsers = '';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: [] },
    });
  });

  it('writes nobody when a row is switched to an allowlist and the box is left empty', () => {
    // The operator changed only the policy, never the text. Omitting the key
    // would hand the channel-wide list back through the runtime's `??`
    // fallback, so the most restrictive action available would silently keep
    // the wider audience while the row claims "empty means nobody".
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': {},
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].senders = 'allowlist';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: [] },
    });
  });

  it('keeps inheriting the member list when an untouched row already had an allowlist policy', () => {
    // A stored policy with no list legitimately means "allowlist, members
    // inherited". Writing [] here would narrow a channel nobody edited, so the
    // empty-list rule fires only when the operator actually changed the policy.
    const groups = {
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist' },
    };
    const instance = githubInstance(structuredClone(groups));

    const request = buildChannelUpsertRequest(
      GITHUB,
      draftFor(instance),
      'rev-2',
      instance,
    );

    expect(request.config['groups']).toEqual(groups);
  });

  it('returns a repository to the channel-wide list when the policy is set back to inherit', () => {
    // The mirror of the case above. An empty array is not nullish, so leaving
    // it behind keeps denying everyone while the row reads "Inherit" and the
    // hint promises the channel-wide list is back.
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: [] },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].senders = '';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': {},
    });
  });

  it('keeps a typed speaker list when the policy is set back to inherit', () => {
    // The box still shows the list, so keeping it matches what the operator
    // sees; only an empty box means "no per-repository list".
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].senders = '';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { allowedUsers: ['alice'] },
    });
  });

  it('keeps a stored list when the policy moves to an allowlist without editing the text', () => {
    // A row that already carries members must not have them clobbered with []
    // just because the policy moved.
    const instance = githubInstance({
      'qwenlm/qwen-code': { senders: 'open', allowedUsers: ['alice'] },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].senders = 'allowlist';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      'qwenlm/qwen-code': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
  });

  it('returns a stored require-mention and policy to inheritance', () => {
    const instance = githubInstance({
      'qwenlm/qwen-code': { requireMention: true, senders: 'open' },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].requireMention = '';
    draft.groupOverrides['qwenlm/qwen-code'].senders = '';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ 'qwenlm/qwen-code': {} });
  });

  it('writes a speaker list while the policy stays inherited', () => {
    // The reason the speaker box is shown for an inheriting row at all.
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': {},
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].allowedUsers = 'alice';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { allowedUsers: ['alice'] },
    });
  });

  it('drops the per-repository list when an inheriting row is cleared', () => {
    const instance = githubInstance({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': { allowedUsers: ['alice'] },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].allowedUsers = '';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['op'] },
      'qwenlm/qwen-code': {},
    });
  });

  it('preserves unmodelled keys beside an edited one', () => {
    const instance = githubInstance({
      'qwenlm/qwen-code': { dispatchMode: 'collect', groupHistoryLimit: 25 },
    });
    const draft = draftFor(instance);

    draft.groupOverrides['qwenlm/qwen-code'].requireMention = 'false';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      'qwenlm/qwen-code': {
        dispatchMode: 'collect',
        groupHistoryLimit: 25,
        requireMention: false,
      },
    });
  });

  it('keeps the settings when the repository is retyped in another case', () => {
    const instance = githubInstance({
      // Unmodelled keys on purpose: with only `requireMention` the draft would
      // reproduce the entry even if the save path stopped folding the stored
      // keys, so the case-fold itself would go unwitnessed.
      'QwenLM/Qwen-Code': {
        requireMention: false,
        dispatchMode: 'collect',
        groupHistoryLimit: 25,
      },
    });
    const draft = draftFor(instance, 'qwenlm/qwen-code');

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({
      'qwenlm/qwen-code': {
        requireMention: false,
        dispatchMode: 'collect',
        groupHistoryLimit: 25,
      },
    });
  });

  it('drops the entry of a repository removed from the allowlist', () => {
    const instance = githubInstance({
      'qwenlm/qwen-code': { requireMention: false },
      'acme/widgets': { senders: 'open' },
    });
    const draft = draftFor(instance, 'qwenlm/qwen-code');

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ 'qwenlm/qwen-code': { requireMention: false } });
  });

  it('keeps a row edit made before the policy was switched away from allowlist', () => {
    // The rows hide once the policy leaves Allowlist, but the draft still holds
    // the edit and the runtime keeps resolving these entries under open and
    // pairing. Rebuilding groups from the stored config would report success
    // while silently restoring the value the operator just changed.
    const instance = githubInstance({
      '*': {},
      'acme/widgets': { requireMention: true },
    });
    const draft = draftFor(instance, 'acme/widgets');
    draft.groupOverrides['acme/widgets'].requireMention = 'false';
    draft.values.groupPolicy = 'pairing';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ '*': {}, 'acme/widgets': { requireMention: false } });
  });

  it('still drops empty entries when the policy leaves allowlist', () => {
    // Projecting the edits must not start retaining entries that carry nothing:
    // acceptance criterion 9 keeps stored settings, not empty placeholders.
    const instance = githubInstance({
      '*': {},
      'acme/widgets': {},
      'qwenlm/qwen-code': { requireMention: true },
    });
    const draft = draftFor(instance, 'acme/widgets, qwenlm/qwen-code');
    draft.values.groupPolicy = 'open';

    expect(
      buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
        'groups'
      ],
    ).toEqual({ '*': {}, 'qwenlm/qwen-code': { requireMention: true } });
  });

  it('leaves chat platforms reading and writing groups exactly as before', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'chat-bot',
      config: {
        type: 'dingtalk',
        clientId: 'id',
        clientSecret: 'secret',
        groupPolicy: 'allowlist',
        // Mixed case on purpose: chat group IDs are case-sensitive, so a
        // lower-cased fixture could not detect the repository case-fold
        // leaking into other platforms.
        groups: { 'Group-A': { requireMention: false } },
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
    draft.allowedGroupIds = 'Group-A';

    expect(draft.groupOverrides).toEqual({});
    expect(
      buildChannelUpsertRequest(DINGTALK_WITH_ACCESS, draft, 'rev-2', instance)
        .config['groups'],
    ).toEqual({ 'Group-A': { requireMention: false } });
  });

  it('names only the repositories the allowlist can actually admit', () => {
    expect(
      repositoryAllowlistIds(
        'QwenLM/qwen-code, qwen-code, acme/widgets, QwenLM/Qwen-Code',
      ),
    ).toEqual(['qwenlm/qwen-code', 'acme/widgets']);
  });

  // Invariant sweep over stored shapes x single-field edits, run through the
  // real save path. The cases above pin individual decisions; these assert the
  // rules those decisions have to keep holding for shapes nobody enumerated.
  const SWEEP_SHAPES: Array<[string, Record<string, unknown>]> = [
    ['empty', {}],
    ['open', { senders: 'open' }],
    ['allowlist', { senders: 'allowlist' }],
    ['allowlist+empty', { senders: 'allowlist', allowedUsers: [] }],
    ['allowlist+names', { senders: 'allowlist', allowedUsers: ['alice'] }],
    ['list-only-empty', { allowedUsers: [] }],
    ['list-only-names', { allowedUsers: ['alice'] }],
    ['mention-true', { requireMention: true }],
    ['mention-false', { requireMention: false }],
    ['unmodelled', { dispatchMode: 'collect', groupHistoryLimit: 25 }],
    ['dup-names', { senders: 'allowlist', allowedUsers: ['alice', 'alice'] }],
    ['mixed-types', { senders: 'allowlist', allowedUsers: ['alice', 42] }],
  ];
  const SWEEP_WILDCARD = {
    senders: 'allowlist',
    allowedUsers: ['op', 'release-bot'],
  };
  const SWEEP_SENDERS = ['', 'open', 'allowlist'] as const;
  const SWEEP_USERS = ['', 'alice', 'alice, bob'] as const;
  const SWEEP_MENTION = ['', 'true', 'false'] as const;

  function sweepDraft(stored: Record<string, unknown>) {
    const instance = githubInstance({
      '*': structuredClone(SWEEP_WILDCARD),
      'qwenlm/qwen-code': structuredClone(stored),
    });
    return { instance, draft: draftFor(instance) };
  }

  function sweepGroups(
    stored: Record<string, unknown>,
    override?: ChannelGroupOverrideDraft,
  ): Record<string, Record<string, unknown>> {
    const { instance, draft } = sweepDraft(stored);
    if (override) {
      draft.groupOverrides['qwenlm/qwen-code'] = override;
    }
    return buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
      'groups'
    ] as Record<string, Record<string, unknown>>;
  }

  // The runtime resolves each key per-repository -> "*" -> built-in, so an
  // absent list is the wildcard's members, not an empty set.
  function sweepAdmits(entry: Record<string, unknown>, who: string): boolean {
    const policy =
      (entry['senders'] as string | undefined) ?? SWEEP_WILDCARD.senders;
    if (policy !== 'allowlist') {
      return true;
    }
    const members =
      (entry['allowedUsers'] as string[] | undefined) ??
      SWEEP_WILDCARD.allowedUsers;
    return members.includes(who);
  }

  it('reproduces every stored shape byte-for-byte when the row is untouched', () => {
    const violations: string[] = [];
    for (const [name, stored] of SWEEP_SHAPES) {
      const saved = sweepGroups(stored)['qwenlm/qwen-code'];
      if (JSON.stringify(saved) !== JSON.stringify(stored)) {
        violations.push(
          `${name}: ${JSON.stringify(stored)} -> ${JSON.stringify(saved)}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the empty-box hint honest about what the save admits', () => {
    const violations: string[] = [];
    for (const [name, stored] of SWEEP_SHAPES) {
      for (const senders of SWEEP_SENDERS) {
        for (const users of SWEEP_USERS) {
          for (const mention of SWEEP_MENTION) {
            // The dialog derives the hint from an EMPTY box, so sweep that
            // hypothetical rather than the draft the operator is typing in.
            const saved = sweepGroups(stored, {
              requireMention: mention,
              senders,
              allowedUsers: '',
            })['qwenlm/qwen-code'];
            const policy =
              (saved['senders'] as string | undefined) ??
              SWEEP_WILDCARD.senders;
            if (policy !== 'allowlist') {
              continue;
            }
            const members =
              (saved['allowedUsers'] as string[] | undefined) ??
              SWEEP_WILDCARD.allowedUsers;
            // Owning a list is what makes the hint say "nobody", so an owned
            // list has to be empty and an absent one has to inherit members.
            if (
              Array.isArray(saved['allowedUsers']) !==
              (members.length === 0)
            ) {
              violations.push(
                `${name} senders=${senders} users=${users} mention=${mention} ` +
                  `saved=${JSON.stringify(saved)}`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('never widens the admitted set without the row asking for it', () => {
    const violations: string[] = [];
    for (const [name, stored] of SWEEP_SHAPES) {
      const initialSenders =
        stored['senders'] === 'open' || stored['senders'] === 'allowlist'
          ? stored['senders']
          : '';
      for (const senders of SWEEP_SENDERS) {
        for (const users of SWEEP_USERS) {
          const saved = sweepGroups(stored, {
            requireMention: '',
            senders,
            allowedUsers: users,
          });
          const after = saved['qwenlm/qwen-code'];
          // Every identity any fixture names: the stored one, the typed ones,
          // and both channel-wide members a silent inheritance would admit.
          for (const who of ['alice', 'bob', 'op', 'release-bot']) {
            if (sweepAdmits(stored, who) || !sweepAdmits(after, who)) {
              continue;
            }
            const askedWider =
              senders === 'open' ||
              (senders === '' && initialSenders === 'allowlist') ||
              users.split(',').some((user) => user.trim() === who) ||
              // Clearing the box under an INHERITED policy hands the repository
              // the channel-wide list, and the row's hint says exactly that. An
              // explicit allowlist is the opposite promise — empty means nobody
              // — so it must never be excused by the list it ended up without.
              (users === '' &&
                after['senders'] !== 'allowlist' &&
                !Array.isArray(after['allowedUsers']));
            if (!askedWider) {
              violations.push(
                `${name} senders=${senders} users=${users} who=${who}: ` +
                  `${JSON.stringify(stored)} -> ${JSON.stringify(after)}`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('GitHub poll interval', () => {
  const GITHUB_POLLING: DaemonChannelTypeDescriptor = {
    ...GITHUB,
    fields: [
      ...GITHUB.fields,
      {
        key: 'pollInterval',
        label: 'Poll Interval (ms)',
        kind: 'number',
        exclusiveMinimum: 0,
        maximum: 86_400_000,
        default: '60000',
      },
    ],
  };

  function pollingDraft(value?: number) {
    const instance: DaemonChannelInstanceSnapshot | undefined =
      value === undefined
        ? undefined
        : {
            name: 'release-bot',
            config: {
              type: 'github',
              groupPolicy: 'open',
              pollInterval: value,
            },
            secrets: { token: { present: true, source: 'literal' } },
            startsWithServe: false,
            runtime: { state: 'stopped' },
          };
    const draft = createChannelEditorDraft(GITHUB_POLLING, instance);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    return { draft, instance };
  }

  it('leaves a new channel unset instead of persisting the descriptor default', () => {
    // The runtime owns the 60-second default. Writing it here would freeze
    // today's value into every channel created from the form.
    const { draft } = pollingDraft();

    expect(draft.values.pollInterval).toBe('');
    expect(
      buildChannelUpsertRequest(GITHUB_POLLING, draft, 'rev-1').config,
    ).not.toHaveProperty('pollInterval');
  });

  it('reads a stored interval and saves a typed one as a number', () => {
    const { draft, instance } = pollingDraft(30000);
    expect(draft.values.pollInterval).toBe('30000');

    draft.values.pollInterval = '45000';
    expect(
      buildChannelUpsertRequest(GITHUB_POLLING, draft, 'rev-2', instance)
        .config['pollInterval'],
    ).toBe(45000);
  });

  it('clears the key when the input is emptied', () => {
    const { draft, instance } = pollingDraft(30000);

    draft.values.pollInterval = '';

    expect(
      buildChannelUpsertRequest(GITHUB_POLLING, draft, 'rev-2', instance)
        .config,
    ).not.toHaveProperty('pollInterval');
  });

  it('rejects a non-positive interval', () => {
    const { draft } = pollingDraft();

    draft.values.pollInterval = '0';
    expect(validateChannelEditorDraft(GITHUB_POLLING, draft, [])).toEqual({
      pollInterval: 'outOfRange',
    });

    draft.values.pollInterval = 'soon';
    expect(validateChannelEditorDraft(GITHUB_POLLING, draft, [])).toEqual({
      pollInterval: 'number',
    });
  });

  it('rejects an interval above the ceiling that would become a hot loop', () => {
    // Node clamps a timeout above its 32-bit range to 1ms, so "once a month"
    // would poll in a tight loop and burn the API quota.
    const { draft } = pollingDraft();

    draft.values.pollInterval = '2592000000';
    expect(validateChannelEditorDraft(GITHUB_POLLING, draft, [])).toEqual({
      pollInterval: 'outOfRange',
    });

    draft.values.pollInterval = '86400000';
    expect(validateChannelEditorDraft(GITHUB_POLLING, draft, [])).toEqual({});
  });

  it('does not block an unrelated edit over a stored interval the runtime tolerates', () => {
    // PollingChannelBase falls back to 60s for a non-positive stored value and
    // clamps one above the ceiling, so a channel carrying 0, -5 or 300000000
    // works today. Declaring the field must not strand its operator on a
    // setting they never touched — both halves of the range, not just the floor.
    for (const stored of [0, -5, 300_000_000]) {
      const { draft, instance } = pollingDraft(stored);
      draft.values.useLocalGh = true;

      expect(
        validateChannelEditorDraft(GITHUB_POLLING, draft, [], instance),
      ).toEqual({});
      expect(
        buildChannelUpsertRequest(GITHUB_POLLING, draft, 'rev-2', instance)
          .config['pollInterval'],
      ).toBe(stored);
    }
  });

  it('still rejects an out-of-range interval the operator actually typed', () => {
    const { draft, instance } = pollingDraft(30000);

    draft.values.pollInterval = '0';
    expect(
      validateChannelEditorDraft(GITHUB_POLLING, draft, [], instance),
    ).toEqual({ pollInterval: 'outOfRange' });
  });
});
