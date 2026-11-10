/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from '@qwen-code/channel-github';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  buildChannelUpsertRequest,
  createChannelEditorDraft,
  validateChannelEditorDraft,
} from './channel-editor-state';

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

const REQUIRE_BOUND_WATCH_CASES = [
  {
    name: 'gate on with delivery off',
    gate: true,
    delivery: false,
    code: 'requiresBoundDeliveryForWatchGate',
    daemon: /requires deliverToBoundSessions/,
  },
  {
    name: 'gate on with delivery on',
    gate: true,
    delivery: true,
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'gate off with delivery off',
    gate: false,
    delivery: false,
    code: undefined,
    daemon: undefined,
  },
] as const;

describe('requireBoundWatch rule parity (editor mirror vs daemon authority)', () => {
  it.each(REQUIRE_BOUND_WATCH_CASES)(
    '$name',
    ({ gate, delivery, code, daemon }) => {
      const config = {
        type: 'github',
        useLocalGh: true,
        deliverToBoundSessions: delivery,
        requireBoundWatch: gate,
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
      )['requireBoundWatch'];
      expect(clientCode).toBe(code);

      const daemonMessage = management.validateConfig?.(config);
      if (daemon) {
        expect(daemonMessage).toMatch(daemon);
      } else {
        expect(daemonMessage).toBeUndefined();
      }
    },
  );
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
