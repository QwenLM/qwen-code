/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from '@qwen-code/channel-github';
import { plugin as emailPlugin } from '@qwen-code/channel-email';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  buildChannelUpsertRequest,
  createChannelEditorDraft,
  validateChannelEditorDraft,
} from './channel-editor-state';
import {
  isChannelPlatformAvailable,
  isPrivateOnlyChannelType,
} from './channel-platform';

// Parity between the editor's client mirror and the daemon authority. The
// descriptor is the plugin's own field list, so a lone change on either side
// (dependency dropped, second precondition added, vocabulary moved) fails
// this table instead of leaving both suites green. Test-only import: the
// plugin is a devDependency and never reaches the web-shell bundle.
// management is optional on ChannelPlugin by contract; narrow once so a
// hypothetical missing descriptor fails with a clear message instead of a
// module-load TypeError (and stays TS18048-clean if test files ever join the
// package typecheck).
const management = plugin.management;
if (!management) {
  throw new Error('@qwen-code/channel-github declares no management metadata.');
}

const descriptor: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: management.fields,
};

const CASES = [
  {
    name: 'delivery off with a selection',
    events: ['ci_failure'],
    delivery: false,
    code: 'requiresBoundDelivery',
    daemon: /requires deliverToBoundSessions/,
  },
  {
    name: 'delivery on with a selection',
    events: ['ci_failure'],
    delivery: true,
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'delivery off with an empty selection',
    events: [],
    delivery: false,
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'delivery off with an unknown value',
    events: ['typo_event'],
    delivery: false,
    code: 'invalidOption',
    daemon: /Unrecognized prWatchEvents/,
  },
] as const;

describe('bound-delivery rule parity (editor mirror vs daemon authority)', () => {
  it.each(CASES)('$name', ({ events, delivery, code, daemon }) => {
    const config = {
      type: 'github',
      useLocalGh: true,
      deliverToBoundSessions: delivery,
      prWatchEvents: [...events],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'parity',
      config,
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';

    const clientCode = validateChannelEditorDraft(
      descriptor,
      draft,
      [],
      instance,
    )['prWatchEvents'];
    expect(clientCode).toBe(code);

    const daemonMessage = management.validateConfig?.(config);
    if (daemon) {
      expect(daemonMessage).toMatch(daemon);
    } else {
      expect(daemonMessage).toBeUndefined();
    }
  });
});

const REPO_FILTER_CASES = [
  {
    name: 'active allowlist with an empty list',
    mode: 'allowlist',
    repos: [] as string[] | undefined,
    code: 'repoFilterRequired',
    daemon: /requires at least one owner\/repo entry/,
  },
  {
    name: 'active blocklist without a list',
    mode: 'blocklist',
    repos: undefined,
    code: 'repoFilterRequired',
    daemon: /must be an array of owner\/repo/,
  },
  {
    name: 'malformed entry',
    mode: 'blocklist',
    repos: ['not-a-repo'],
    code: 'invalidRepoId',
    daemon: /must be owner\/repo repository names/,
  },
  {
    name: 'valid allowlist',
    mode: 'allowlist',
    repos: ['octo/repo'],
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'valid blocklist',
    mode: 'blocklist',
    repos: ['octo/repo'],
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'off with a stale list',
    mode: 'off',
    repos: ['not-a-repo'],
    code: undefined,
    daemon: undefined,
  },
] as const;

describe('repository filter rule parity (editor mirror vs daemon authority)', () => {
  it.each(REPO_FILTER_CASES)('$name', ({ mode, repos, code, daemon }) => {
    const config: Record<string, unknown> = {
      type: 'github',
      useLocalGh: true,
      repoFilterMode: mode,
    };
    if (repos !== undefined) config['repoFilter'] = [...repos];
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'parity',
      config,
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';

    const clientCode = validateChannelEditorDraft(
      descriptor,
      draft,
      [],
      instance,
    )['repoFilter'];
    expect(clientCode).toBe(code);

    const daemonMessage = management.validateConfig?.(config);
    if (daemon) {
      expect(daemonMessage).toMatch(daemon);
    } else {
      expect(daemonMessage).toBeUndefined();
    }
  });

  it('shortens pasted URLs before the daemon authority sees them', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'parity',
      config: { type: 'github', useLocalGh: true },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';
    draft.values['repoFilterMode'] = 'blocklist';
    draft.values['repoFilter'] = 'https://github.com/Octo/Repo/pull/9';

    expect(validateChannelEditorDraft(descriptor, draft, [], instance)).toEqual(
      {},
    );
    const { config } = buildChannelUpsertRequest(
      descriptor,
      draft,
      'rev-1',
      instance,
    );
    expect(config['repoFilter']).toEqual(['octo/repo']);
    expect(management.validateConfig?.(config)).toBeUndefined();
  });

  it('binds a GHES paste through the editor and the daemon authority', () => {
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'parity',
      config: {
        type: 'github',
        useLocalGh: true,
        baseUrl: 'https://ghe.example.com/api/v3',
      },
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';
    draft.values['repoFilterMode'] = 'blocklist';
    draft.values['repoFilter'] = 'https://ghe.example.com/octo/repo';

    expect(validateChannelEditorDraft(descriptor, draft, [], instance)).toEqual(
      {},
    );
    const { config } = buildChannelUpsertRequest(
      descriptor,
      draft,
      'rev-1',
      instance,
    );
    expect(config['repoFilter']).toEqual(['octo/repo']);
    expect(management.validateConfig?.(config)).toBeUndefined();
  });
});

describe('default-on boolean fields survive a UI save', () => {
  const instanceWith = (
    config: Record<string, unknown>,
  ): DaemonChannelInstanceSnapshot => ({
    name: 'parity',
    config: { type: 'github', useLocalGh: true, ...config },
    secrets: {},
    startsWithServe: false,
    runtime: { state: 'stopped' },
  });

  it('seeds and saves prCommentWatch=true when the key is absent', () => {
    const instance = instanceWith({ deliverToBoundSessions: true });
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';
    expect(draft.values['prCommentWatch']).toBe(true);
    const { config } = buildChannelUpsertRequest(
      descriptor,
      draft,
      'rev-1',
      instance,
    );
    expect(config['prCommentWatch']).toBe(true);
  });

  it('keeps an explicitly stored prCommentWatch=false', () => {
    const instance = instanceWith({
      deliverToBoundSessions: true,
      prCommentWatch: false,
    });
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';
    expect(draft.values['prCommentWatch']).toBe(false);
    const { config } = buildChannelUpsertRequest(
      descriptor,
      draft,
      'rev-1',
      instance,
    );
    expect(config['prCommentWatch']).toBe(false);
  });
});

const emailManagement = emailPlugin.management;
if (!emailManagement) {
  throw new Error('@qwen-code/channel-email declares no management metadata.');
}

// it.each([]) would register no cases and report a green suite, so the sweep
// fails loudly instead of silently covering nothing.
const emailRequiredFields = emailPlugin.requiredConfigFields;
if (!emailRequiredFields?.length) {
  throw new Error(
    '@qwen-code/channel-email declares no required config fields.',
  );
}

const emailDescriptor: DaemonChannelTypeDescriptor = {
  type: 'email',
  displayName: 'Email',
  manageable: true,
  fields: emailManagement.fields,
};

describe('Email parity (real plugin vs editor projection)', () => {
  function emailDraft() {
    const draft = createChannelEditorDraft(emailDescriptor);
    draft.name = 'agent-mail';
    draft.values['address'] = 'agent@example.com';
    draft.values['imapHost'] = 'imap.example.com';
    draft.values['imapUser'] = 'agent@example.com';
    draft.values['smtpHost'] = 'smtp.example.com';
    draft.values['smtpUser'] = 'agent@example.com';
    draft.secrets['imapPassword'] = {
      operation: 'replace',
      value: 'imap-secret',
    };
    draft.secrets['smtpPassword'] = {
      operation: 'replace',
      value: 'smtp-secret',
    };
    return draft;
  }

  /**
   * The store applies secret updates into the config and only then validates,
   * so the authority must see the resolved secrets rather than the wire shape
   * the editor submits.
   */
  function resolveSecrets(
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...config,
      imapPassword: 'imap-secret',
      smtpPassword: 'smtp-secret',
    };
  }

  it('admits the real plugin as a private-only manageable platform', () => {
    expect(isChannelPlatformAvailable(emailDescriptor)).toBe(true);
    expect(isPrivateOnlyChannelType(emailDescriptor.type)).toBe(true);
  });

  it('declares the private policy the editor takes, and no group policy', () => {
    const policy = emailManagement.fields.find(
      (field) => field.key === 'privatePolicy',
    );
    expect(policy?.kind).toBe('enum');
    expect(policy?.default).toBe('allowlist');
    expect(policy?.options?.map((option) => option.value)).toEqual([
      'disabled',
      'allowlist',
      'open',
    ]);
    // The registry injects `groupPolicy` precisely because the plugin does not
    // declare it. If that ever changes, the private-only handling needs a look.
    expect(
      emailManagement.fields.some((field) => field.key === 'groupPolicy'),
    ).toBe(false);
  });

  it('builds a configuration the plugin authority accepts', () => {
    const draft = emailDraft();
    expect(validateChannelEditorDraft(emailDescriptor, draft, [])).toEqual({});

    const { config } = buildChannelUpsertRequest(
      emailDescriptor,
      draft,
      'rev-1',
    );
    expect(
      emailManagement.validateConfig?.(resolveSecrets(config)),
    ).toBeUndefined();
  });

  it('seeds implicit TLS from the descriptor default and saves it unchanged', () => {
    // assignField() writes an explicit boolean, so a draft seeded false would
    // persist imapSecure:false and drop the mailbox to STARTTLS on 143/587.
    // The plugin really declares these defaults, so this is a live pin.
    const draft = emailDraft();
    expect(draft.values['imapSecure']).toBe(true);
    expect(draft.values['smtpSecure']).toBe(true);

    const { config } = buildChannelUpsertRequest(
      emailDescriptor,
      draft,
      'rev-1',
    );
    expect(config['imapSecure']).toBe(true);
    expect(config['smtpSecure']).toBe(true);
    expect(
      emailManagement.validateConfig?.(resolveSecrets(config)),
    ).toBeUndefined();
  });

  it('does not flip implicit TLS off when editing an unrelated field', () => {
    // A channel configured through settings.json omits the switches and runs
    // on the documented 993/465 defaults; opening it must not rewrite them.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'agent-mail',
      config: {
        type: 'email',
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        imapUser: 'agent@example.com',
        smtpHost: 'smtp.example.com',
        smtpUser: 'agent@example.com',
        privatePolicy: 'allowlist',
      },
      secrets: {
        imapPassword: { present: true, source: 'environment' },
        smtpPassword: { present: true, source: 'environment' },
      },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(emailDescriptor, instance);
    draft.values['address'] = 'renamed@example.com';

    const { config } = buildChannelUpsertRequest(
      emailDescriptor,
      draft,
      'rev-2',
      instance,
    );
    expect(config['imapSecure']).toBe(true);
    expect(config['smtpSecure']).toBe(true);
    expect(config['address']).toBe('renamed@example.com');
  });

  it('keeps an explicitly stored STARTTLS choice on an unrelated save', () => {
    // The default-seeding must not override a deliberate false: a mailbox
    // configured for STARTTLS (143/587) stays that way after an unrelated edit.
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'agent-mail',
      config: {
        type: 'email',
        address: 'agent@example.com',
        imapHost: 'imap.example.com',
        imapUser: 'agent@example.com',
        smtpHost: 'smtp.example.com',
        smtpUser: 'agent@example.com',
        privatePolicy: 'allowlist',
        imapSecure: false,
        smtpSecure: false,
      },
      secrets: {
        imapPassword: { present: true, source: 'environment' },
        smtpPassword: { present: true, source: 'environment' },
      },
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(emailDescriptor, instance);
    expect(draft.values['imapSecure']).toBe(false);
    expect(draft.values['smtpSecure']).toBe(false);
    draft.values['folder'] = 'Archive';

    const { config } = buildChannelUpsertRequest(
      emailDescriptor,
      draft,
      'rev-3',
      instance,
    );
    expect(config['imapSecure']).toBe(false);
    expect(config['smtpSecure']).toBe(false);
    expect(config['folder']).toBe('Archive');
  });

  it('declares upper bounds the editor enforces inline', () => {
    // The runtime (email config.ts) rejects above these maxima; without a
    // declared `maximum` the editor let them through and the save failed with
    // only a banner. The literals pin the descriptor against the runtime so
    // the two cannot drift apart.
    const expected: Record<string, number> = {
      imapPort: 65535,
      smtpPort: 65535,
      pollInterval: 86_400_000,
      maxMessageBytes: 52_428_800,
      maxAttachmentBytes: 52_428_800,
      maxTextLength: 100_000,
    };
    for (const [key, max] of Object.entries(expected)) {
      const field = emailManagement.fields.find((f) => f.key === key);
      expect(field?.maximum).toBe(max);

      const over = emailDraft();
      over.values[key] = String(max + 1);
      expect(validateChannelEditorDraft(emailDescriptor, over, [])[key]).toBe(
        'outOfRange',
      );

      const at = emailDraft();
      at.values[key] = String(max);
      expect(
        validateChannelEditorDraft(emailDescriptor, at, [])[key],
      ).toBeUndefined();
    }
  });

  it.each(emailRequiredFields)(
    'agrees with the authority when %s is missing',
    (key) => {
      const draft = emailDraft();
      if (key === 'imapPassword' || key === 'smtpPassword') {
        draft.secrets[key] = { operation: 'replace', value: '' };
      } else {
        draft.values[key] = '';
      }

      expect(validateChannelEditorDraft(emailDescriptor, draft, [])[key]).toBe(
        'required',
      );

      const { config } = buildChannelUpsertRequest(
        emailDescriptor,
        draft,
        'rev-1',
      );
      const resolved = resolveSecrets(config);
      // The secret itself is what went missing, so do not restore it here.
      if (key === 'imapPassword' || key === 'smtpPassword') {
        delete resolved[key];
      }
      expect(emailManagement.validateConfig?.(resolved)).toMatch(/Email/);
    },
  );

  it('lets the authority reject a pairing policy the editor cannot offer', () => {
    const draft = emailDraft();
    draft.values['privatePolicy'] = 'pairing';

    const { config } = buildChannelUpsertRequest(
      emailDescriptor,
      draft,
      'rev-1',
    );
    expect(emailManagement.validateConfig?.(resolveSecrets(config))).toMatch(
      /pairing/,
    );
  });
});
