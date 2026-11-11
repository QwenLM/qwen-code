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
  GITHUB_RESERVED_URL_PATHS,
  invalidRepositoryGroupEntries,
  isRepoFilterActive,
  normalizeRepositoryFilterInput,
  repositoryAllowlistIds,
  retainedRepositorySettings,
  validateChannelEditorDraft,
} from './channel-editor-state';
import type {
  ChannelEditorDraft,
  ChannelGroupOverrideDraft,
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

// GitLab declares groupPolicy itself and receives the same injected
// privatePolicy/allowedUsers as GitHub; its adapter is group-only too.
const GITLAB: DaemonChannelTypeDescriptor = {
  type: 'gitlab',
  displayName: 'GitLab',
  manageable: true,
  fields: [
    {
      key: 'token',
      label: 'Personal Access Token',
      kind: 'secret',
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
        { value: 'pairing', label: 'Pairing' },
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

describe('GitHub watch events require bound delivery', () => {
  const BOUND: DaemonChannelTypeDescriptor = {
    ...GITHUB,
    fields: [
      ...GITHUB.fields,
      {
        key: 'deliverToBoundSessions',
        label: 'Deliver To PR-Bound Sessions',
        kind: 'boolean',
      },
      {
        key: 'prWatchEvents',
        label: 'PR Watch Events',
        kind: 'string-list',
        options: [
          { value: 'ci_failure', label: 'ci_failure' },
          { value: 'merge_conflict', label: 'merge_conflict' },
        ],
      },
    ],
  };

  function draftWithEvents(events: string): ChannelEditorDraft {
    const draft = createChannelEditorDraft(BOUND);
    draft.name = 'my-bot';
    draft.values.useLocalGh = true;
    draft.values.prWatchEvents = events;
    return draft;
  }

  it('refuses a watch selection while bound delivery is off', () => {
    expect(
      validateChannelEditorDraft(BOUND, draftWithEvents('ci_failure'), []),
    ).toEqual({ prWatchEvents: 'requiresBoundDelivery' });
  });

  it('allows the selection once bound delivery is on', () => {
    const draft = draftWithEvents('ci_failure');
    draft.values.deliverToBoundSessions = true;
    expect(validateChannelEditorDraft(BOUND, draft, [])).toEqual({});
  });

  it('leaves an empty selection alone with delivery off', () => {
    expect(validateChannelEditorDraft(BOUND, draftWithEvents(''), [])).toEqual(
      {},
    );
  });

  it('reports invalidOption before the delivery dependency', () => {
    expect(
      validateChannelEditorDraft(BOUND, draftWithEvents('typo_event'), []),
    ).toEqual({ prWatchEvents: 'invalidOption' });
  });
});

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

  it('drops the private-access residue for GitLab too', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'open',
        privatePolicy: 'pairing',
        allowedUsers: ['alice'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);

    const request = buildChannelUpsertRequest(GITLAB, draft, 'rev-2', instance);
    expect(request.config).not.toHaveProperty('privatePolicy');
    expect(request.config).not.toHaveProperty('allowedUsers');
  });

  it('admits a nested GitLab project path and saves it as a group key', () => {
    const draft = createChannelEditorDraft(GITLAB);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'glpat-test' };
    draft.values.groupPolicy = 'allowlist';
    draft.allowedGroupIds = 'mygroup/subgroup/project';

    expect(validateChannelEditorDraft(GITLAB, draft, [])).toEqual({});
    const request = buildChannelUpsertRequest(GITLAB, draft, 'rev-1');
    expect(request.config['groups']).toEqual({
      'mygroup/subgroup/project': {},
    });
  });

  it('still rejects a malformed GitLab allowlist entry', () => {
    const draft = createChannelEditorDraft(GITLAB);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'glpat-test' };
    draft.values.groupPolicy = 'allowlist';
    draft.allowedGroupIds = 'solo';

    expect(validateChannelEditorDraft(GITLAB, draft, [])).toEqual({
      allowedGroupIds: 'invalidRepoId',
    });
  });

  it('keeps GitHub strict to owner/repo for the allowlist', () => {
    const draft = createChannelEditorDraft(GITHUB);
    draft.name = 'release-bot';
    draft.secrets.token = { operation: 'replace', value: 'ghp_test' };
    draft.values.groupPolicy = 'allowlist';
    draft.allowedGroupIds = 'owner/repo/extra';

    expect(validateChannelEditorDraft(GITHUB, draft, [])).toEqual({
      allowedGroupIds: 'invalidRepoId',
    });
  });

  it('keeps a nested GitLab project narrowed during a temporary switch when the save lands on Open', () => {
    // The non-Allowlist save path projects draft-only repositories through
    // repositoryAllowlistIds, which must use the GitLab shape: a nested path
    // typed during this visit survives the switch back to Open. With the
    // GitHub shape (the default if the channel type is not threaded) the
    // 3-segment path is filtered out and its restriction silently vanishes.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'open',
        groups: { '*': { senders: 'open' } },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);
    draft.values.groupPolicy = 'open';
    draft.allowedGroupIds = 'mygroup/subgroup/newproj';
    draft.groupOverrides['mygroup/subgroup/newproj'] = {
      requireMention: '',
      senders: 'allowlist',
      allowedUsers: 'alice',
    };

    expect(validateChannelEditorDraft(GITLAB, draft, [], instance)).toEqual({});
    const groups = buildChannelUpsertRequest(GITLAB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    expect(groups['mygroup/subgroup/newproj']).toEqual({
      senders: 'allowlist',
      allowedUsers: ['alice'],
    });
  });

  it('leaves a preserved GitLab repoFilter untouched on save', () => {
    // repoFilter is GitHub-only; a GitLab channel may carry it as a preserved
    // unmanaged key. The save path must not canonicalize it (the daemon rejects
    // a modified unmanaged field), matching the GitHub-gated validator.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'open',
        repoFilterMode: 'allowlist',
        repoFilter: ['MyGroup/SubProject'],
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);
    const request = buildChannelUpsertRequest(GITLAB, draft, 'rev-2', instance);
    expect(request.config['repoFilter']).toEqual(['MyGroup/SubProject']);
  });

  it('tolerates a stored GitLab allowlist entry that predates the shape check', () => {
    // A single-segment key was storable before GitLab joined the repository-only
    // set; an unrelated edit must not be blocked by a shape check the entry was
    // never validated against.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'allowlist',
        groups: { mygroup: {} },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);
    expect(validateChannelEditorDraft(GITLAB, draft, [], instance)).toEqual({});
  });

  it('still rejects a newly typed malformed GitLab entry', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'allowlist',
        groups: { 'mygroup/project': {} },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);
    draft.allowedGroupIds = 'mygroup/project, solo';
    expect(validateChannelEditorDraft(GITLAB, draft, [], instance)).toEqual({
      allowedGroupIds: 'invalidRepoId',
    });
  });

  it('keeps a stored mixed-case GitLab project and its sender policy across a re-save', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'gitlab',
        groupPolicy: 'allowlist',
        groups: {
          'CalcProgrammer1/OpenRGB': {
            senders: 'allowlist',
            allowedUsers: ['alice'],
          },
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITLAB, instance);
    expect(validateChannelEditorDraft(GITLAB, draft, [], instance)).toEqual({});
    const groups = buildChannelUpsertRequest(GITLAB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    // Assert the behaviour (the project survives with its settings), not the
    // spelling the editor canonicalizes to.
    const entry = Object.entries(groups).find(
      ([id]) => id.toLowerCase() === 'calcprogrammer1/openrgb',
    );
    expect(entry).toBeDefined();
    expect(entry?.[1]).toEqual({
      senders: 'allowlist',
      allowedUsers: ['alice'],
    });
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

/**
 * Email's descriptor as the daemon ships it. The plugin declares its own
 * `privatePolicy` without `pairing`, so the registry injects `groupPolicy` and
 * the other shared access fields but no private policy. The parity suite drives
 * the real plugin; this fixture keeps the projection cases readable.
 */
const EMAIL: DaemonChannelTypeDescriptor = {
  type: 'email',
  displayName: 'Email',
  manageable: true,
  fields: [
    {
      key: 'address',
      label: 'Mailbox Address',
      kind: 'string',
      required: true,
    },
    {
      key: 'imapHost',
      label: 'IMAP Host',
      kind: 'string',
      required: true,
    },
    {
      key: 'imapPassword',
      label: 'IMAP Password',
      kind: 'secret',
      required: true,
    },
    {
      key: 'smtpPassword',
      label: 'SMTP Password',
      kind: 'secret',
      required: true,
    },
    {
      key: 'proactiveRecipients',
      label: 'Proactive Recipients',
      kind: 'string-list',
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
        { value: 'open', label: 'Open' },
      ],
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
    {
      key: 'allowedUsers',
      label: 'Allowed Users',
      kind: 'string-list',
    },
    {
      key: 'operators',
      label: 'Session Operators',
      kind: 'string-list',
    },
  ],
};

describe('Private-only channel access config', () => {
  function emailDraft(): ChannelEditorDraft {
    const draft = createChannelEditorDraft(EMAIL);
    draft.name = 'agent-mail';
    draft.values.address = 'agent@example.com';
    draft.values.imapHost = 'imap.example.com';
    draft.secrets.imapPassword = { operation: 'replace', value: 'imap-secret' };
    draft.secrets.smtpPassword = { operation: 'replace', value: 'smtp-secret' };
    return draft;
  }

  function emailInstance(
    config: Record<string, unknown>,
  ): DaemonChannelInstanceSnapshot {
    return {
      name: 'agent-mail',
      config: {
        type: 'email',
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        privatePolicy: 'allowlist',
        ...config,
      },
      secrets: {
        imapPassword: { present: true, source: 'environment' },
        smtpPassword: { present: true, source: 'environment' },
      },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
  }

  it('does not persist the injected group policy', () => {
    const request = buildChannelUpsertRequest(EMAIL, emailDraft(), 'rev-1');
    expect(request.config).not.toHaveProperty('groupPolicy');
    expect(request.config).not.toHaveProperty('groups');
    expect(request.config['privatePolicy']).toBe('allowlist');
  });

  it('takes the plugin private policy, never the shared pairing default', () => {
    const draft = createChannelEditorDraft(EMAIL);
    expect(draft.values['privatePolicy']).toBe('allowlist');
    // '' selects the descriptor-declared enum instead of the four-card radio
    // group, which is the only place `pairing` is offered.
    expect(draft.privatePolicy).toBe('');
    expect(draft.values).not.toHaveProperty('groupPolicy');
  });

  it('does not ask for the group policy it never renders', () => {
    expect(validateChannelEditorDraft(EMAIL, emailDraft(), [])).toEqual({});
  });

  it('does not flag a required group policy the draft deliberately omits', () => {
    // Pins the validator's private-only skip: with a blank groupPolicy value
    // present, the required-check would otherwise report 'required' for a
    // control the editor never renders. Without the skip this goes red.
    const draft = emailDraft();
    draft.values['groupPolicy'] = '';
    expect(
      validateChannelEditorDraft(EMAIL, draft, [])['groupPolicy'],
    ).toBeUndefined();
  });

  it('leaves a non-record stored group entry untouched on save', () => {
    // Pins the save-path private-only guard: without it, assignGroups() would
    // rebuild groups and coerce a non-record entry to {}, rewriting stored
    // data the editor does not model. Email has no invalidGroupEntry backstop.
    const instance = emailInstance({
      groupPolicy: 'allowlist',
      groups: { g1: 'not-a-record' },
    });
    const draft = createChannelEditorDraft(EMAIL, instance);
    const request = buildChannelUpsertRequest(EMAIL, draft, 'rev-9', instance);
    expect(request.config['groups']).toEqual({ g1: 'not-a-record' });
  });

  it('preserves a stored group policy and groups on an unrelated save', () => {
    // Skipping the field in the draft but not in the save would let
    // assignField() read an absent key as empty and delete both.
    const instance = emailInstance({
      groupPolicy: 'allowlist',
      groups: { 'legacy-group': { senders: 'open' } },
    });
    const draft = createChannelEditorDraft(EMAIL, instance);
    draft.values.address = 'renamed@example.com';

    const request = buildChannelUpsertRequest(EMAIL, draft, 'rev-2', instance);
    expect(request.config['groupPolicy']).toBe('allowlist');
    expect(request.config['groups']).toEqual({
      'legacy-group': { senders: 'open' },
    });
    expect(request.config['address']).toBe('renamed@example.com');
  });

  it('preserves a stored pairing group policy without validating against it', () => {
    const instance = emailInstance({
      groupPolicy: 'pairing',
      groups: { '*': { senders: 'allowlist', allowedUsers: ['alice'] } },
    });
    const draft = createChannelEditorDraft(EMAIL, instance);

    expect(validateChannelEditorDraft(EMAIL, draft, [], instance)).toEqual({});
    const request = buildChannelUpsertRequest(EMAIL, draft, 'rev-3', instance);
    expect(request.config['groupPolicy']).toBe('pairing');
    expect(request.config['groups']).toEqual({
      '*': { senders: 'allowlist', allowedUsers: ['alice'] },
    });
  });

  it('keeps both password secrets preserved on an existing channel', () => {
    const instance = emailInstance({});
    const draft = createChannelEditorDraft(EMAIL, instance);

    expect(
      buildChannelUpsertRequest(EMAIL, draft, 'rev-4', instance).secrets,
    ).toEqual({
      imapPassword: { operation: 'preserve' },
      smtpPassword: { operation: 'preserve' },
    });
  });

  it('round-trips proactive recipients through the comma-separated input', () => {
    const draft = emailDraft();
    draft.values.proactiveRecipients = 'a@x.com, b@x.com';

    const request = buildChannelUpsertRequest(EMAIL, draft, 'rev-5');
    expect(request.config['proactiveRecipients']).toEqual([
      'a@x.com',
      'b@x.com',
    ]);

    const reopened = createChannelEditorDraft(
      EMAIL,
      emailInstance({ proactiveRecipients: ['a@x.com', 'b@x.com'] }),
    );
    expect(reopened.values['proactiveRecipients']).toBe('a@x.com, b@x.com');
  });

  it('still writes the group policy for a group-capable sibling', () => {
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS);
    draft.name = 'release-bot';
    draft.values.clientId = 'id';
    draft.secrets.clientSecret = { operation: 'replace', value: 'secret' };

    const request = buildChannelUpsertRequest(
      DINGTALK_WITH_ACCESS,
      draft,
      'rev-6',
    );
    expect(request.config['groupPolicy']).toBe('disabled');
  });
});

/**
 * Stored per-repository shapes the sweeps cross with edits and policies. Shared
 * by the override, non-Allowlist and conflicting-alias sweeps so a new shape
 * reaches every one of them.
 */
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
        'github',
      ),
    ).toEqual(['qwenlm/qwen-code', 'acme/widgets']);
  });

  it('names nested GitLab project paths the allowlist can admit', () => {
    expect(
      repositoryAllowlistIds(
        'MyGroup/SubGroup/Project, mygroup/project, solo, a/b/c/d',
        'gitlab',
      ),
    ).toEqual(['mygroup/subgroup/project', 'mygroup/project', 'a/b/c/d']);
  });

  it('keeps GitHub strict to owner/repo while GitLab accepts nested paths', () => {
    // The same multi-segment id is rejected for GitHub (no repository has that
    // shape) but admitted for GitLab (a project in a subgroup).
    expect(repositoryAllowlistIds('owner/repo/extra', 'github')).toEqual([]);
    expect(repositoryAllowlistIds('owner/repo/extra', 'gitlab')).toEqual([
      'owner/repo/extra',
    ]);
  });

  // Invariant sweep over stored shapes x single-field edits, run through the
  // real save path. The cases above pin individual decisions; these assert the
  // rules those decisions have to keep holding for shapes nobody enumerated.
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

  // The dimension the sweep above missed: it only ever ran under Allowlist. The
  // runtime resolves senders and members without consulting groupPolicy, so the
  // policy a save lands on must not change what a row writes or who it admits.
  const SWEEP_POLICIES = ['allowlist', 'open', 'pairing', 'disabled'] as const;

  function sweepPolicyGroups(
    stored: Record<string, unknown>,
    storedPolicy: string,
    finalPolicy: string,
    override?: ChannelGroupOverrideDraft,
    draftOnly?: ChannelGroupOverrideDraft,
  ): Record<string, unknown> {
    const instance = githubInstance({
      '*': structuredClone(SWEEP_WILDCARD),
      'qwenlm/qwen-code': structuredClone(stored),
    });
    instance.config['groupPolicy'] = storedPolicy;
    const draft = draftFor(instance);
    draft.values['groupPolicy'] = finalPolicy;
    if (override) {
      draft.groupOverrides['qwenlm/qwen-code'] = override;
    }
    if (draftOnly) {
      // A repository typed during this visit: a draft with no stored entry,
      // which is the shape iterating storage alone cannot see.
      draft.allowedGroupIds = 'qwenlm/qwen-code, acme/new';
      draft.groupOverrides['acme/new'] = draftOnly;
    }
    return buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
      'groups'
    ] as Record<string, unknown>;
  }

  // An empty entry is membership under Allowlist and carries nothing once the
  // policy leaves it, so the two paths differ in whether they keep the key —
  // never in what it admits.
  function sweepEntry(
    groups: Record<string, unknown>,
    repositoryId = 'qwenlm/qwen-code',
  ): Record<string, unknown> {
    return (groups[repositoryId] ?? {}) as Record<string, unknown>;
  }

  it('writes the same repository entry whatever policy the save lands on', () => {
    const violations: string[] = [];
    for (const [name, stored] of SWEEP_SHAPES) {
      for (const senders of SWEEP_SENDERS) {
        for (const users of SWEEP_USERS) {
          const override: ChannelGroupOverrideDraft = {
            requireMention: '',
            senders,
            allowedUsers: users,
          };
          const reference = sweepPolicyGroups(
            stored,
            'allowlist',
            'allowlist',
            override,
            override,
          );
          for (const repositoryId of ['qwenlm/qwen-code', 'acme/new']) {
            const expected = JSON.stringify(
              sweepEntry(reference, repositoryId),
            );
            for (const storedPolicy of ['allowlist', 'open']) {
              for (const finalPolicy of SWEEP_POLICIES) {
                const actual = JSON.stringify(
                  sweepEntry(
                    sweepPolicyGroups(
                      stored,
                      storedPolicy,
                      finalPolicy,
                      override,
                      override,
                    ),
                    repositoryId,
                  ),
                );
                if (actual !== expected) {
                  violations.push(
                    `${name} ${repositoryId} senders=${senders} users=${users} ` +
                      `${storedPolicy}->${finalPolicy}: ${expected} -> ${actual}`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('admits the same people after an untouched policy switch', () => {
    const violations: string[] = [];
    const identities = ['alice', 'bob', 'op', 'release-bot'];
    for (const [name, stored] of SWEEP_SHAPES) {
      for (const storedPolicy of ['allowlist', 'open']) {
        for (const finalPolicy of SWEEP_POLICIES) {
          const saved = sweepPolicyGroups(stored, storedPolicy, finalPolicy);
          for (const who of identities) {
            if (
              sweepAdmits(stored, who) !== sweepAdmits(sweepEntry(saved), who)
            ) {
              violations.push(
                `${name} ${storedPolicy}->${finalPolicy} who=${who}: ` +
                  `${JSON.stringify(stored)} -> ${JSON.stringify(saved)}`,
              );
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('Repository settings under a non-Allowlist policy', () => {
  // Per-repository senders and members are resolved without consulting
  // groupPolicy (ChannelBase.groupSendersFor / groupAllowedUsersFor), so these
  // entries keep deciding who may drive the agent under open and pairing. Each
  // case asserts the admitted set, not just the saved shape: every one of these
  // paths used to widen a repository while reporting a successful save.
  function admits(
    groups: Record<string, unknown>,
    repositoryId: string,
    who: string,
  ): boolean {
    const entry = (groups[repositoryId] ?? {}) as Record<string, unknown>;
    const wildcard = (groups['*'] ?? {}) as Record<string, unknown>;
    const policy = entry['senders'] ?? wildcard['senders'] ?? 'open';
    if (policy !== 'allowlist') return true;
    const members = (entry['allowedUsers'] ??
      wildcard['allowedUsers'] ??
      []) as string[];
    return members.includes(who);
  }

  function githubStored(
    groups: Record<string, unknown>,
    groupPolicy: string,
  ): DaemonChannelInstanceSnapshot {
    return {
      name: 'release-bot',
      config: { type: 'github', groupPolicy, groups },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
  }

  function savedGroups(
    instance: DaemonChannelInstanceSnapshot,
    edit: (draft: ReturnType<typeof createChannelEditorDraft>) => void,
  ) {
    const draft = createChannelEditorDraft(GITHUB, instance);
    edit(draft);
    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({});
    return buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance).config[
      'groups'
    ] as Record<string, unknown>;
  }

  it('keeps a row narrowed during a temporary switch on a channel stored Open', () => {
    // The alert tells the operator to switch back to Allowlist to edit a row, so
    // "switch, narrow, switch back, save" is a flow the UI invites. Gating the
    // write on the STORED policy dropped the edit and left the repository open.
    const instance = githubStored(
      { '*': { senders: 'open' }, 'acme/widgets': { senders: 'open' } },
      'open',
    );
    const groups = savedGroups(instance, (draft) => {
      draft.values['groupPolicy'] = 'open';
      draft.allowedGroupIds = 'acme/widgets';
      draft.groupOverrides['acme/widgets'] = {
        requireMention: '',
        senders: 'allowlist',
        allowedUsers: 'alice',
      };
    });

    expect(groups['acme/widgets']).toEqual({
      senders: 'allowlist',
      allowedUsers: ['alice'],
    });
    expect(admits(groups, 'acme/widgets', 'bob')).toBe(false);
    expect(admits(groups, 'acme/widgets', 'alice')).toBe(true);
  });

  it('keeps a repository added while Allowlist when the save lands on Open', () => {
    // Iterating stored groups alone cannot see a repository that only exists in
    // the draft, so its restriction vanished and it fell back to the wildcard.
    const instance = githubStored(
      { '*': { senders: 'open' }, 'acme/widgets': {} },
      'allowlist',
    );
    const groups = savedGroups(instance, (draft) => {
      draft.values['groupPolicy'] = 'open';
      draft.allowedGroupIds = 'acme/widgets, acme/new';
      draft.groupOverrides['acme/new'] = {
        requireMention: '',
        senders: 'allowlist',
        allowedUsers: 'alice',
      };
    });

    expect(groups['acme/new']).toEqual({
      senders: 'allowlist',
      allowedUsers: ['alice'],
    });
    expect(admits(groups, 'acme/new', 'bob')).toBe(false);
  });

  it('leaves conflicting aliases as stored when only the policy moves', () => {
    // The draft keeps one entry per lower-cased id, so it cannot say which
    // spelling an edit was meant for. Projecting the last alias's draft onto
    // both turned an alice-only repository open while validation stayed silent,
    // because the conflict check only runs when the final policy is Allowlist.
    const instance = githubStored(
      {
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'Acme/Widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
        'acme/widgets': { senders: 'open' },
      },
      'allowlist',
    );
    const groups = savedGroups(instance, (draft) => {
      draft.values['groupPolicy'] = 'open';
    });

    expect(groups['Acme/Widgets']).toEqual({
      senders: 'allowlist',
      allowedUsers: ['alice'],
    });
    expect(groups['acme/widgets']).toEqual({ senders: 'open' });
    // The runtime prefers an exact key, and GitHub keeps the repository's case.
    expect(admits(groups, 'Acme/Widgets', 'bob')).toBe(false);
  });

  it('still refuses the same conflict when the policy stays Allowlist', () => {
    const instance = githubStored(
      {
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'Acme/Widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
        'acme/widgets': { senders: 'open' },
      },
      'allowlist',
    );
    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({
      allowedGroupIds: 'conflictingRepoAliases',
    });
  });

  it('reproduces an untouched non-Allowlist channel byte-for-byte', () => {
    const groups = {
      '*': { senders: 'open' },
      'acme/widgets': { senders: 'allowlist', allowedUsers: ['alice'] },
      'acme/other': { dispatchMode: 'collect', groupHistoryLimit: 25 },
      'Acme/Mixed': { requireMention: false },
    };
    const instance = githubStored(structuredClone(groups), 'open');
    const draft = createChannelEditorDraft(GITHUB, instance);

    const saved = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'];
    expect(JSON.stringify(saved)).toBe(JSON.stringify(groups));
  });

  it('keeps an already-empty entry when an unrelated edit lands on Open', () => {
    // The channel never had an allowlist, so its stored entries are not
    // membership markers this save may clean up. Dropping the empty one
    // rewrote settings.json on an edit that never touched groups. Admission is
    // the same either way — an absent key and an empty entry both fall through
    // to "*" — which is why this is about the file, not about access.
    const stored = { '*': { senders: 'open' }, 'acme/widgets': {} };
    const instance = githubStored(structuredClone(stored), 'open');
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.values['baseUrl'] = 'https://ghe.example.com/api/v3';

    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({});
    const groups = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'];
    expect(JSON.stringify(groups)).toBe(JSON.stringify(stored));
  });

  it('still drops a draft-only repository that carries no settings', () => {
    // Preserving stored empty entries must not materialize new ones: a
    // repository typed into the allowlist with nothing set has no entry to keep.
    const instance = githubStored({ '*': { senders: 'open' } }, 'open');
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.allowedGroupIds = 'acme/widgets';

    const groups = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    expect(Object.hasOwn(groups, 'acme/widgets')).toBe(false);
  });

  it('refuses a lone non-record repository entry and does not delete it', () => {
    // With only one spelling there is no alias ambiguity, so that exemption
    // does not apply — but an entry the form cannot represent is still not
    // ours to delete. Validation refuses the save and names it instead.
    const instance = githubStored(
      {
        '*': { senders: 'allowlist', allowedUsers: ['op'] },
        'acme/widgets': 'hand-written-garbage',
      },
      'allowlist',
    );
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.values['groupPolicy'] = 'open';

    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({
      groupPolicy: 'invalidGroupEntry',
    });
    expect(invalidRepositoryGroupEntries(instance)).toEqual(['acme/widgets']);
    const groups = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    expect(groups['acme/widgets']).toBe('hand-written-garbage');
  });

  it('does not invent repository entries for a chat platform', () => {
    // The union with the typed allowlist is repository-only: chat group ids are
    // case-sensitive and are not derived from that field once the policy leaves
    // Allowlist.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'chat-bot',
      config: {
        type: 'dingtalk',
        clientId: 'id',
        clientSecret: 'secret',
        groupPolicy: 'open',
        groups: {
          '*': { senders: 'open' },
          'Group-A': { requireMention: false },
        },
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(DINGTALK_WITH_ACCESS, instance);
    draft.allowedGroupIds = 'Group-A, Group-B';

    expect(
      buildChannelUpsertRequest(DINGTALK_WITH_ACCESS, draft, 'rev-2', instance)
        .config['groups'],
    ).toEqual({
      '*': { senders: 'open' },
      'Group-A': { requireMention: false },
    });
  });
});

describe('Conflicting repository aliases across policies', () => {
  // Two spellings of one repository that disagree. The draft keeps a single
  // lower-cased entry, so it cannot say which spelling an edit was meant for,
  // and the runtime resolves an exact own key first and only then falls back to
  // the first case-insensitive match (ChannelBase.groupConfigFor). Both facts
  // are load-bearing: an empty exact entry inherits "*", while deleting it lets
  // the fallback reach a wider alias.
  const ALIAS_WILDCARD = { senders: 'allowlist', allowedUsers: ['op'] };
  const OPEN_ALIAS = { senders: 'open' };
  const OTHER_POLICIES = ['open', 'pairing', 'disabled'] as const;

  function resolveEntry(
    groups: Record<string, unknown>,
    chatId: string,
  ): Record<string, unknown> {
    if (Object.hasOwn(groups, chatId)) {
      return groups[chatId] as Record<string, unknown>;
    }
    const normalized = chatId.toLowerCase();
    for (const [groupId, group] of Object.entries(groups)) {
      if (groupId.toLowerCase() === normalized) {
        return group as Record<string, unknown>;
      }
    }
    return {};
  }

  function aliasAdmits(
    groups: Record<string, unknown>,
    chatId: string,
    who: string,
  ): boolean {
    const entry = resolveEntry(groups, chatId);
    const wildcard = resolveEntry(groups, '*');
    const policy = entry['senders'] ?? wildcard['senders'] ?? 'open';
    if (policy !== 'allowlist') return true;
    const members = (entry['allowedUsers'] ??
      wildcard['allowedUsers'] ??
      []) as string[];
    return members.includes(who);
  }

  function aliasInstance(
    upper: unknown,
    storedPolicy: string,
  ): DaemonChannelInstanceSnapshot {
    return {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: storedPolicy,
        groups: {
          '*': structuredClone(ALIAS_WILDCARD),
          'Acme/Widgets': structuredClone(upper),
          'acme/widgets': structuredClone(OPEN_ALIAS),
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
  }

  function aliasSave(
    upper: unknown,
    storedPolicy: string,
    finalPolicy: string,
    edit?: Partial<ChannelGroupOverrideDraft>,
  ) {
    const instance = aliasInstance(upper, storedPolicy);
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.values['groupPolicy'] = finalPolicy;
    if (edit) {
      draft.groupOverrides['acme/widgets'] = {
        ...draft.groupOverrides['acme/widgets'],
        ...edit,
      };
    }
    const errors = validateChannelEditorDraft(GITHUB, draft, [], instance);
    const groups = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    return { errors, groups, stored: instance.config['groups'] };
  }

  it('keeps an empty ambiguous alias on an untouched Open save', () => {
    // The empty entry is what makes the exact key inherit the wildcard's
    // allowlist. Dropping it as "carrying nothing" hands the repository to the
    // open alias through the case-insensitive fallback, on a save that changed
    // nothing at all.
    const { errors, groups, stored } = aliasSave({}, 'open', 'open');

    expect(errors).toEqual({});
    expect(Object.hasOwn(groups, 'Acme/Widgets')).toBe(true);
    expect(groups['Acme/Widgets']).toEqual({});
    expect(JSON.stringify(groups)).toBe(JSON.stringify(stored));
    expect(
      aliasAdmits(stored as Record<string, unknown>, 'Acme/Widgets', 'bob'),
    ).toBe(false);
    expect(aliasAdmits(groups, 'Acme/Widgets', 'bob')).toBe(false);
  });

  it('refuses an edited ambiguous row once the policy leaves Allowlist', () => {
    // The visible row is the canonical id, which shows the open alias. Editing
    // it and switching away used to save successfully while discarding the
    // edit, so the hint's "Empty means nobody" never happened.
    for (const allowedUsers of ['', 'alice']) {
      const { errors } = aliasSave(
        { senders: 'allowlist', allowedUsers: ['alice'] },
        'allowlist',
        'open',
        { senders: 'allowlist', allowedUsers },
      );
      expect(errors).toEqual({ groupPolicy: 'conflictingRepoAliases' });
    }
  });

  it('refuses an edited mention on an ambiguous row too', () => {
    const { errors } = aliasSave(
      { senders: 'allowlist', allowedUsers: ['alice'] },
      'allowlist',
      'pairing',
      { requireMention: 'false' },
    );
    expect(errors).toEqual({ groupPolicy: 'conflictingRepoAliases' });
  });

  it('still saves an untouched ambiguous switch and keeps both spellings', () => {
    const { errors, groups, stored } = aliasSave(
      { senders: 'allowlist', allowedUsers: ['alice'] },
      'allowlist',
      'open',
    );

    expect(errors).toEqual({});
    expect(JSON.stringify(groups)).toBe(JSON.stringify(stored));
    expect(aliasAdmits(groups, 'Acme/Widgets', 'bob')).toBe(false);
  });

  it('still refuses any ambiguous save while the policy is Allowlist', () => {
    const instance = aliasInstance({ senders: 'allowlist' }, 'allowlist');
    const draft = createChannelEditorDraft(GITHUB, instance);

    expect(validateChannelEditorDraft(GITHUB, draft, [], instance)).toEqual({
      allowedGroupIds: 'conflictingRepoAliases',
    });
  });

  it('refuses a hand-written non-record alias instead of deleting it', () => {
    // The store rejects a non-record group entry on every save, unchanged or
    // not — its tolerance covers the whole `groups` value, not an entry inside
    // it — so this cannot be promised as a no-op. Deleting the entry instead
    // would remove the exact key and let the case-insensitive fallback reach
    // the open alias. Refuse with the entry named, and still do not delete it.
    const { errors, groups, stored } = aliasSave(
      'hand-written-garbage',
      'open',
      'open',
    );

    expect(errors).toEqual({ groupPolicy: 'invalidGroupEntry' });
    expect(groups['Acme/Widgets']).toBe('hand-written-garbage');
    expect(JSON.stringify(groups)).toBe(JSON.stringify(stored));
    expect(
      aliasAdmits(stored as Record<string, unknown>, 'Acme/Widgets', 'bob'),
    ).toBe(false);
    expect(aliasAdmits(groups, 'Acme/Widgets', 'bob')).toBe(false);
  });

  it('still drops a non-ambiguous empty entry when the policy leaves Allowlist', () => {
    // The exemption is for aliases the draft cannot tell apart, not for every
    // empty entry: a lone repository returned to inherit must not leave a stub.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: 'allowlist',
        groups: {
          '*': structuredClone(ALIAS_WILDCARD),
          'qwenlm/qwen-code': {},
        },
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.values['groupPolicy'] = 'open';

    const groups = buildChannelUpsertRequest(GITHUB, draft, 'rev-2', instance)
      .config['groups'] as Record<string, unknown>;
    expect(Object.hasOwn(groups, 'qwenlm/qwen-code')).toBe(false);
  });

  // The alias dimension the earlier sweeps did not cross: every stored shape,
  // as the upper spelling, against a fixed open lower spelling, over every
  // stored and final policy. An untouched save must be a no-op and an edited
  // row must be refused — the two failures this path actually shipped.
  it('is a no-op untouched and refuses an edit, for every shape and policy', () => {
    const noopViolations: string[] = [];
    const editViolations: string[] = [];
    const identities = ['alice', 'bob', 'op'];
    for (const [name, shape] of SWEEP_SHAPES) {
      if (JSON.stringify(shape) === JSON.stringify(OPEN_ALIAS)) continue;
      for (const storedPolicy of ['allowlist', 'open']) {
        for (const finalPolicy of OTHER_POLICIES) {
          const untouched = aliasSave(shape, storedPolicy, finalPolicy);
          const label = `${name} ${storedPolicy}->${finalPolicy}`;
          if (
            JSON.stringify(untouched.groups) !==
            JSON.stringify(untouched.stored)
          ) {
            noopViolations.push(
              `${label}: ${JSON.stringify(untouched.stored)} -> ${JSON.stringify(untouched.groups)}`,
            );
          }
          if (Object.keys(untouched.errors).length > 0) {
            noopViolations.push(
              `${label} refused: ${JSON.stringify(untouched.errors)}`,
            );
          }
          for (const who of identities) {
            const before = aliasAdmits(
              untouched.stored as Record<string, unknown>,
              'Acme/Widgets',
              who,
            );
            if (before !== aliasAdmits(untouched.groups, 'Acme/Widgets', who)) {
              noopViolations.push(`${label} who=${who} admission changed`);
            }
          }
          // Whether an edit is real depends on the shape: the draft collapses
          // to the open alias, so "choose open" is a no-op for most shapes and
          // must still save. Assert both directions rather than assuming.
          const seeded = createChannelEditorDraft(
            GITHUB,
            aliasInstance(shape, storedPolicy),
          ).groupOverrides['acme/widgets'];
          for (const edit of [
            { senders: 'allowlist', allowedUsers: '' },
            { senders: 'allowlist', allowedUsers: 'carol' },
            { senders: 'open' },
            { requireMention: 'false' },
          ] as Array<Partial<ChannelGroupOverrideDraft>>) {
            const next = { ...seeded, ...edit };
            const changed =
              !seeded ||
              next.requireMention !== seeded.requireMention ||
              next.senders !== seeded.senders ||
              next.allowedUsers !== seeded.allowedUsers;
            const edited = aliasSave(shape, storedPolicy, finalPolicy, edit);
            if (changed) {
              if (edited.errors['groupPolicy'] !== 'conflictingRepoAliases') {
                editViolations.push(
                  `${label} edit=${JSON.stringify(edit)} errors=${JSON.stringify(edited.errors)}`,
                );
              }
            } else if (Object.keys(edited.errors).length > 0) {
              noopViolations.push(
                `${label} no-op edit=${JSON.stringify(edit)} refused: ${JSON.stringify(edited.errors)}`,
              );
            }
          }
        }
      }
    }
    expect(noopViolations).toEqual([]);
    expect(editViolations).toEqual([]);
  });
});

describe('Retained repository settings announcement', () => {
  function announce(
    storedGroups: Record<string, unknown>,
    storedPolicy: string,
    finalPolicy: string,
    edit?: (draft: ReturnType<typeof createChannelEditorDraft>) => void,
  ) {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'release-bot',
      config: {
        type: 'github',
        groupPolicy: storedPolicy,
        groups: storedGroups,
      },
      secrets: { token: { present: true, source: 'literal' } },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(GITHUB, instance);
    draft.values['groupPolicy'] = finalPolicy;
    if (edit) edit(draft);
    return retainedRepositorySettings(GITHUB, draft, instance);
  }

  it('names a repository the save writes but storage has never seen', () => {
    // Typing a repository, narrowing its row and switching the policy away
    // writes an entry that keeps deciding who may drive it. Enumerating stored
    // groups named nothing, so the dialog reported success in silence.
    const named = announce(
      { '*': { senders: 'allowlist', allowedUsers: ['op'] } },
      'allowlist',
      'open',
      (draft) => {
        draft.allowedGroupIds = 'acme/widgets';
        draft.groupOverrides['acme/widgets'] = {
          requireMention: '',
          senders: 'allowlist',
          allowedUsers: 'alice',
        };
      },
    );

    expect(named).toEqual([{ repositoryId: 'acme/widgets', applies: true }]);
  });

  it('does not announce a speaker list the resolved policy makes inert', () => {
    // senderGateFor builds an allowlist only when the resolved policy is
    // allowlist, so an array beside an inherited open policy restricts nobody.
    const named = announce(
      {
        '*': { senders: 'open' },
        'acme/widgets': { allowedUsers: ['alice'] },
      },
      'allowlist',
      'open',
    );

    expect(named).toEqual([{ repositoryId: 'acme/widgets', applies: false }]);
  });

  it('does not announce an entry whose only keys are unmodelled', () => {
    const named = announce(
      { '*': { senders: 'open' }, 'acme/widgets': { groupHistoryLimit: 25 } },
      'allowlist',
      'open',
    );

    expect(named).toEqual([{ repositoryId: 'acme/widgets', applies: false }]);
  });

  it('announces an entry-level policy or mention that still changes behaviour', () => {
    const named = announce(
      {
        '*': { senders: 'open', requireMention: true },
        'acme/policy': { senders: 'allowlist', allowedUsers: ['alice'] },
        'acme/mention': { requireMention: false },
        'acme/same': { requireMention: true },
      },
      'allowlist',
      'open',
    );

    expect(named).toEqual([
      { repositoryId: 'acme/policy', applies: true },
      { repositoryId: 'acme/mention', applies: true },
      // Equal to the inherited value, so it changes nothing today.
      { repositoryId: 'acme/same', applies: false },
    ]);
  });

  it('announces nothing when the save keeps no repository settings', () => {
    expect(announce({ '*': { senders: 'open' } }, 'open', 'open')).toEqual([]);
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

describe('GitHub repository event filter', () => {
  const REPO_FILTER: DaemonChannelTypeDescriptor = {
    ...GITHUB,
    fields: [
      ...GITHUB.fields,
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'string',
        envResolvable: true,
      },
      {
        key: 'repoFilterMode',
        label: 'Repository Filter',
        kind: 'enum',
        default: 'off',
        options: [
          { value: 'off', label: 'off' },
          { value: 'allowlist', label: 'allowlist' },
          { value: 'blocklist', label: 'blocklist' },
        ],
      },
      {
        key: 'repoFilter',
        label: 'Filtered Repositories',
        kind: 'string-list',
      },
    ],
  };

  function filterDraft(
    mode: string,
    list: string,
    instance?: DaemonChannelInstanceSnapshot,
  ): ChannelEditorDraft {
    const draft = createChannelEditorDraft(REPO_FILTER, instance);
    draft.name = 'my-bot';
    draft.values.useLocalGh = true;
    draft.values.repoFilterMode = mode;
    draft.values.repoFilter = list;
    return draft;
  }

  describe('normalizeRepositoryFilterInput', () => {
    it('shortens pasted GitHub web URLs to owner/repo', () => {
      expect(
        normalizeRepositoryFilterInput(
          'https://github.com/Octo/Repo, https://github.com/Octo/Repo/pull/123, octo/repo',
        ),
      ).toBe('octo/repo');
    });

    it('shortens URLs on the GHES host derived from baseUrl', () => {
      expect(
        normalizeRepositoryFilterInput(
          'https://ghe.example.com/octo/repo.git/',
          'https://ghe.example.com/api/v3',
        ),
      ).toBe('octo/repo');
      // Without the channel's baseUrl, the same host is not shortenable.
      expect(
        normalizeRepositoryFilterInput(
          'https://ghe.example.com/octo/repo.git/',
        ),
      ).toBe('https://ghe.example.com/octo/repo.git/');
    });

    it('does not shorten URLs on hosts other than the channel GitHub host', () => {
      // The structural half of the guard: the first two path segments of an
      // arbitrary host are not a repository. Each of these once shortened to
      // a plausible owner/repo that both validators accepted.
      const foreign = [
        'https://api.github.com/repos/octo/repo',
        'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
        'https://gist.github.com/octocat/6cad1f0e5d3b2a9c',
        'https://gitlab.com/group/project',
      ];
      for (const url of foreign) {
        expect(normalizeRepositoryFilterInput(url)).toBe(url.toLowerCase());
        expect(
          validateChannelEditorDraft(
            REPO_FILTER,
            filterDraft('allowlist', url),
            [],
          ),
        ).toEqual({ repoFilter: 'invalidRepoId' });
      }
    });

    it('shortens URLs carrying a query or fragment', () => {
      expect(
        normalizeRepositoryFilterInput(
          'https://github.com/Octo/Repo?tab=readme-ov-file, https://github.com/Octo/Repo#readme',
        ),
      ).toBe('octo/repo');
    });

    it('rejects REST-shaped URLs on the channel own API host', () => {
      // The host gate must not re-admit the channel's own API host: with
      // baseUrl set, a REST URL (the shape `gh api` prints) must pass through
      // for validation to reject, not shorten to `repos/octo` or `api/v3`.
      const cases = [
        ['https://api.github.com/repos/octo/repo', 'https://api.github.com'],
        [
          'https://ghe.example.com/api/v3/repos/octo/repo',
          'https://ghe.example.com/api/v3',
        ],
      ];
      for (const [url, baseUrl] of cases) {
        expect(normalizeRepositoryFilterInput(url!, baseUrl)).toBe(
          url!.toLowerCase(),
        );
        const draft = filterDraft('allowlist', url!);
        draft.values.baseUrl = baseUrl!;
        expect(validateChannelEditorDraft(REPO_FILTER, draft, [])).toEqual({
          repoFilter: 'invalidRepoId',
        });
      }
    });

    it('strips trailing sentence punctuation from a pasted URL', () => {
      expect(
        normalizeRepositoryFilterInput(
          'https://github.com/octo/repo., https://github.com/octo/repo)',
        ),
      ).toBe('octo/repo');
      expect(
        validateChannelEditorDraft(
          REPO_FILTER,
          filterDraft('blocklist', 'https://github.com/octo/repo.'),
          [],
        ),
      ).toEqual({});
    });

    it('binds the GHES host through both the validator and the save path', () => {
      // Dropping either baseUrl argument must fail here: the validator would
      // reject the paste while the save path still shortens it (or vice
      // versa) — the editor/daemon divergence the shared normalizer prevents.
      const instance: DaemonChannelInstanceSnapshot = {
        name: 'my-bot',
        config: {
          type: 'github',
          useLocalGh: true,
          baseUrl: 'https://ghe.example.com/api/v3',
        },
        secrets: {},
        startsWithServe: false,
        runtime: { state: 'stopped' },
      };
      const draft = filterDraft(
        'blocklist',
        'https://ghe.example.com/octo/repo',
        instance,
      );
      expect(
        validateChannelEditorDraft(REPO_FILTER, draft, [], instance),
      ).toEqual({});
      const request = buildChannelUpsertRequest(
        REPO_FILTER,
        draft,
        'rev-1',
        instance,
      );
      expect(request.config['repoFilter']).toEqual(['octo/repo']);
    });

    it('does not shorten non-repository GitHub URLs', () => {
      // Regression pins for the measured verify-round shapes: each of these
      // once shortened to a plausible-but-nonexistent owner/repo that both
      // validators accepted — fatal under an allowlist. The capitalized
      // variant pins the guard's own lowercasing of the path root.
      const hostile = [
        'https://github.com/orgs/community',
        'https://github.com/Orgs/community',
        'https://github.com/settings/profile',
        'https://github.com/apps/renovate',
        'https://github.com/features/copilot',
        'https://github.com/trending/typescript',
        'https://github.com/pricing/enterprise',
        'https://github.com/advisories/GHSA-xxxx-xxxx-xxxx',
        'https://github.com/copilot/c/abc123',
      ];
      for (const url of hostile) {
        expect(normalizeRepositoryFilterInput(url)).toBe(url.toLowerCase());
        expect(
          validateChannelEditorDraft(
            REPO_FILTER,
            filterDraft('allowlist', url),
            [],
          ),
        ).toEqual({ repoFilter: 'invalidRepoId' });
      }
    });

    it('pins the whole reserved-area set, not a sample of it', () => {
      // A snapshot over every member: removing any root from the set fails
      // here, which the it.each enumeration alone cannot witness (it would
      // simply run one case fewer).
      expect([...GITHUB_RESERVED_URL_PATHS].sort()).toEqual(
        [
          'about',
          'account',
          'accounts',
          'advisories',
          'apps',
          'codespaces',
          'collections',
          'contact',
          'copilot',
          'customer-stories',
          'discussions',
          'enterprise',
          'enterprises',
          'events',
          'explore',
          'features',
          'followers',
          'following',
          'issues',
          'join',
          'login',
          'logout',
          'marketplace',
          'mobile',
          'new',
          'notifications',
          'orgs',
          'organizations',
          'password_reset',
          'premium-support',
          'pricing',
          'pulls',
          'readme',
          'search',
          'security',
          'sessions',
          'settings',
          'signup',
          'site',
          'sponsors',
          'stars',
          'team',
          'topics',
          'trending',
          'users',
          'watching',
        ].sort(),
      );
    });

    it.each([...GITHUB_RESERVED_URL_PATHS])(
      'rejects every reserved GitHub area root: %s',
      (root) => {
        // Enumerates the whole guard set so a newly added root is covered the
        // moment it lands, instead of waiting for a hand-picked fixture.
        const url = `https://github.com/${root}/some-page`;
        expect(normalizeRepositoryFilterInput(url)).toBe(url);
        expect(
          validateChannelEditorDraft(
            REPO_FILTER,
            filterDraft('blocklist', url),
            [],
          ),
        ).toEqual({ repoFilter: 'invalidRepoId' });
      },
    );

    it('lowercases and deduplicates plain entries', () => {
      expect(
        normalizeRepositoryFilterInput('Owner/Repo, owner/repo, other/repo'),
      ).toBe('owner/repo, other/repo');
    });

    it('passes non-URL entries through for validation to name', () => {
      expect(normalizeRepositoryFilterInput('not-a-repo, a/b')).toBe(
        'not-a-repo, a/b',
      );
      expect(normalizeRepositoryFilterInput('  ')).toBe('');
    });
  });

  it('isRepoFilterActive only accepts the two list modes', () => {
    expect(isRepoFilterActive('allowlist')).toBe(true);
    expect(isRepoFilterActive('blocklist')).toBe(true);
    expect(isRepoFilterActive('off')).toBe(false);
    expect(isRepoFilterActive(undefined)).toBe(false);
  });

  it('seeds Off for a new draft and for an instance without the keys', () => {
    expect(createChannelEditorDraft(REPO_FILTER).values.repoFilterMode).toBe(
      'off',
    );
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: { type: 'github', useLocalGh: true },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    expect(
      createChannelEditorDraft(REPO_FILTER, instance).values.repoFilterMode,
    ).toBe('off');
  });

  it('requires a non-empty list while a mode is active', () => {
    expect(
      validateChannelEditorDraft(REPO_FILTER, filterDraft('allowlist', ''), []),
    ).toEqual({ repoFilter: 'repoFilterRequired' });
    expect(
      validateChannelEditorDraft(
        REPO_FILTER,
        filterDraft('blocklist', '  '),
        [],
      ),
    ).toEqual({ repoFilter: 'repoFilterRequired' });
  });

  it('rejects entries that are not owner/repo after normalization', () => {
    expect(
      validateChannelEditorDraft(
        REPO_FILTER,
        filterDraft('blocklist', 'not-a-repo'),
        [],
      ),
    ).toEqual({ repoFilter: 'invalidRepoId' });
  });

  it('accepts pasted URLs and ignores the list while off', () => {
    expect(
      validateChannelEditorDraft(
        REPO_FILTER,
        filterDraft('allowlist', 'https://github.com/Octo/Repo/pull/1'),
        [],
      ),
    ).toEqual({});
    expect(
      validateChannelEditorDraft(
        REPO_FILTER,
        filterDraft('off', 'not-a-repo'),
        [],
      ),
    ).toEqual({});
  });

  it('normalizes the list in the save payload while a mode is active', () => {
    const request = buildChannelUpsertRequest(
      REPO_FILTER,
      filterDraft(
        'blocklist',
        'https://github.com/Octo/Repo/pull/9, Other/Repo',
      ),
      'rev-1',
    );
    expect(request.config['repoFilterMode']).toBe('blocklist');
    expect(request.config['repoFilter']).toEqual(['octo/repo', 'other/repo']);
  });

  it('keeps a parked list exactly as stored while the mode is off', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'my-bot',
      config: {
        type: 'github',
        useLocalGh: true,
        repoFilterMode: 'off',
        repoFilter: ['Owner/Parked'],
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(REPO_FILTER, instance);
    draft.name = 'my-bot';
    const request = buildChannelUpsertRequest(
      REPO_FILTER,
      draft,
      'rev-1',
      instance,
    );
    expect(request.config['repoFilter']).toEqual(['Owner/Parked']);
  });
});
