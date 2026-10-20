/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { buildHooksListing, type HooksListingConfig } from './hooks-listing.js';
import { HookRegistry, type HookRegistryEntry } from './hookRegistry.js';
import { SessionHooksManager } from './sessionHooksManager.js';
import type { HookSystem } from './hookSystem.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  type HookConfig,
  type HookDefinition,
} from './types.js';

const SESSION_ID = 'session-1';

function entry(
  config: HookConfig,
  overrides: Partial<HookRegistryEntry> = {},
): HookRegistryEntry {
  return {
    config,
    source: HooksConfigSource.User,
    eventName: HookEventName.PreToolUse,
    enabled: true,
    ...overrides,
  };
}

function makeConfig(options: {
  entries?: () => HookRegistryEntry[];
  session?: SessionHooksManager;
  sessionId?: string;
  hookSystem?: false;
  disableAll?: boolean;
  safeMode?: boolean;
  bareMode?: boolean;
  trusted?: boolean;
  systemHooks?: Record<string, unknown>;
  userHooks?: Record<string, unknown>;
  projectHooks?: Record<string, unknown>;
  extensions?: Array<{ isActive: boolean; hooks?: Record<string, unknown> }>;
}): HooksListingConfig {
  const session = options.session ?? new SessionHooksManager();
  const hookSystem = {
    getAllHooks: () => options.entries?.() ?? [],
    getSessionHooksManager: () => session,
  } as unknown as HookSystem;
  return {
    getHookSystem: vi
      .fn()
      .mockReturnValue(options.hookSystem === false ? undefined : hookSystem),
    getDisableAllHooks: vi.fn().mockReturnValue(options.disableAll ?? false),
    isSafeMode: vi.fn().mockReturnValue(options.safeMode ?? false),
    getBareMode: vi.fn().mockReturnValue(options.bareMode ?? false),
    getSessionId: vi.fn().mockReturnValue(options.sessionId ?? SESSION_ID),
    isTrustedFolder: vi.fn().mockReturnValue(options.trusted ?? true),
    getSystemHooks: vi.fn().mockReturnValue(options.systemHooks),
    getUserHooks: vi.fn().mockReturnValue(options.userHooks),
    getProjectHooks: vi.fn().mockReturnValue(options.projectHooks),
    getExtensions: vi.fn().mockReturnValue(options.extensions ?? []),
  } as unknown as HooksListingConfig;
}

/** Registry entries produced by the real registry from user settings. */
async function registryEntries(
  userHooks: Record<string, unknown>,
): Promise<HookRegistry> {
  const registry = new HookRegistry({
    getProjectRoot: () => '/project',
    isTrustedFolder: () => true,
    getSystemHooks: () => undefined,
    getUserHooks: () => userHooks,
    getProjectHooks: () => undefined,
    getExtensions: () => [],
  });
  await registry.initialize();
  return registry;
}

const LINT_SETTINGS: { [K in HookEventName]?: HookDefinition[] } = {
  [HookEventName.PreToolUse]: [
    {
      hooks: [{ type: HookType.Command, command: './lint.sh', name: 'lint' }],
    },
  ],
};

type ConfigOptions = Parameters<typeof makeConfig>[0];
const rows = (options: ConfigOptions) =>
  buildHooksListing(makeConfig(options)).rows;

/** Rows from the real registry built from LINT_SETTINGS; `lint` maybe off. */
async function lintRows(options: ConfigOptions = {}, disableLint = false) {
  const registry = await registryEntries(LINT_SETTINGS);
  if (disableLint) {
    registry.setHookEnabled('lint', false);
  }
  return rows({ ...options, entries: () => registry.getAllHooks() });
}

describe('buildHooksListing', () => {
  it('flattens each hook type into its identity and literal text', () => {
    const longPrompt = 'x'.repeat(60);
    const listed = rows({
      entries: () => [
        entry({ type: HookType.Command, command: './lint.sh' }),
        entry({
          type: HookType.Http,
          url: 'https://hooks.example.com/audit',
        }),
        entry({
          type: HookType.Function,
          id: 'fn-1',
          callback: async () => undefined,
          errorMessage: 'failed',
        }),
        entry({ type: HookType.Prompt, prompt: longPrompt }),
      ],
    });

    expect(
      listed.map((row) => [row.hookType, row.displayText, row.commandText]),
    ).toEqual([
      ['command', './lint.sh', './lint.sh'],
      [
        'http',
        'https://hooks.example.com/audit',
        'https://hooks.example.com/audit',
      ],
      ['function', 'fn-1', undefined],
      ['prompt', `${'x'.repeat(50)}...`, longPrompt],
    ]);
  });

  it('marks an async command hook as running in the background, not once', () => {
    const [row] = rows({
      entries: () => [
        entry({ type: HookType.Command, command: 'sleep 1', async: true }),
      ],
    });

    expect(row?.runsInBackground).toBe(true);
    expect(row).not.toHaveProperty('runsOnce');
  });

  it('carries an HTTP hook once flag and its if condition', () => {
    const [row] = rows({
      entries: () => [
        entry({
          type: HookType.Http,
          url: 'https://hooks.example.com/once',
          once: true,
          if: 'Bash(git *)',
        }),
      ],
    });

    expect(row?.runsOnce).toBe(true);
    expect(row?.condition).toBe('Bash(git *)');
    expect(row).not.toHaveProperty('runsInBackground');
  });

  it('reads timeout and statusMessage from every hook type', () => {
    const listed = rows({
      entries: () => [
        entry({
          type: HookType.Command,
          command: 'a',
          timeout: 5,
          statusMessage: 'Linting…',
        }),
        entry({
          type: HookType.Http,
          url: 'https://hooks.example.com/b',
          timeout: 6,
          statusMessage: 'Auditing…',
        }),
        entry({
          type: HookType.Function,
          id: 'c',
          callback: async () => undefined,
          errorMessage: 'failed',
          timeout: 7,
          statusMessage: 'Checking goal…',
        }),
        entry({
          type: HookType.Prompt,
          prompt: 'd',
          timeout: 8,
          statusMessage: 'Judging…',
        }),
      ],
    });

    expect(listed.map((row) => [row.timeout, row.statusMessage])).toEqual([
      [5, 'Linting…'],
      [6, 'Auditing…'],
      [7, 'Checking goal…'],
      [8, 'Judging…'],
    ]);
  });

  it('reports the registry enabled state instead of assuming enabled', async () => {
    const [row] = await lintRows({}, true);

    expect(row?.enabled).toBe(false);
    expect(row?.origin).toBe('registry');
  });

  it('lists hooks registered for the current session after the registry', () => {
    const session = new SessionHooksManager();
    const hookId = session.addFunctionHook(
      SESSION_ID,
      HookEventName.Stop,
      '',
      async () => undefined,
      'goal check failed',
      { name: 'goal-stop-hook', statusMessage: 'Checking goal…' },
    );
    session.addFunctionHook(
      'another-session',
      HookEventName.Stop,
      '',
      async () => undefined,
      'other',
      { name: 'other-session-hook' },
    );

    const listed = rows({
      session,
      entries: () => [entry({ type: HookType.Command, command: './lint.sh' })],
    });

    expect(listed.map((row) => row.displayText)).toEqual([
      './lint.sh',
      'goal-stop-hook',
    ]);
    const sessionRow = listed[1];
    expect(sessionRow).toMatchObject({
      eventName: HookEventName.Stop,
      source: HooksConfigSource.Session,
      origin: 'session',
      enabled: true,
      hookType: HookType.Function,
      hookId,
      statusMessage: 'Checking goal…',
    });
    expect(sessionRow).not.toHaveProperty('matcher');
  });

  it('keeps a registry row in the registry origin even when its source is session', () => {
    const [row] = rows({
      entries: () => [
        entry(
          { type: HookType.Command, command: './agent-hook.sh' },
          { source: HooksConfigSource.Session, agentScope: 'agent-1' },
        ),
      ],
    });

    expect(row?.source).toBe(HooksConfigSource.Session);
    expect(row?.origin).toBe('registry');
  });

  it('keeps configured rows when hooks are disabled and reports the mode flags', () => {
    const listing = buildHooksListing(
      makeConfig({
        disableAll: true,
        safeMode: true,
        bareMode: true,
        entries: () => [
          entry({ type: HookType.Command, command: './lint.sh' }),
        ],
      }),
    );

    expect(listing).toMatchObject({
      allDisabled: true,
      safeMode: true,
      bareMode: true,
    });
    expect(listing.rows).toHaveLength(1);
  });

  it('returns no rows without a hook system when nothing is configured', () => {
    const listing = buildHooksListing(
      makeConfig({ hookSystem: false, disableAll: true }),
    );

    expect(listing).toEqual({
      rows: [],
      allDisabled: true,
      safeMode: false,
      bareMode: false,
    });
  });

  it('omits an empty matcher and keeps a configured one', () => {
    const listed = rows({
      entries: () => [
        entry({ type: HookType.Command, command: 'a' }, { matcher: '' }),
        entry(
          { type: HookType.Command, command: 'b' },
          { matcher: 'Write|Edit', sequential: true },
        ),
      ],
    });

    expect(listed[0]).not.toHaveProperty('matcher');
    expect(listed[1]).toMatchObject({
      matcher: 'Write|Edit',
      sequential: true,
    });
  });

  describe('enabled and disabledReason', () => {
    it('reports registryDisabled for an entry switched off in the registry', async () => {
      const [row] = await lintRows({}, true);

      expect(row).toMatchObject({
        enabled: false,
        disabledReason: 'registryDisabled',
      });
    });

    it('has no disabledReason when every gate is open', async () => {
      const [row] = await lintRows();

      expect(row?.enabled).toBe(true);
      expect(row).not.toHaveProperty('disabledReason');
    });

    it('reports allHooksDisabled for every row under disableAllHooks', async () => {
      const listed = await lintRows({ disableAll: true }, true);

      expect(listed.map((row) => [row.enabled, row.disabledReason])).toEqual([
        [false, 'allHooksDisabled'],
      ]);
    });

    it('reports safeMode ahead of allHooksDisabled', async () => {
      const [row] = await lintRows({ safeMode: true, disableAll: true });

      expect(row).toMatchObject({ enabled: false, disabledReason: 'safeMode' });
    });

    it('reports bareMode ahead of safeMode and allHooksDisabled', async () => {
      const [row] = await lintRows({
        bareMode: true,
        safeMode: true,
        disableAll: true,
      });

      expect(row).toMatchObject({ enabled: false, disabledReason: 'bareMode' });
    });

    /** The row for one session hook (`trustGated` or not) in a folder. */
    function trustGatedRow(trustGated: boolean, trusted: boolean) {
      const session = new SessionHooksManager();
      session.addSessionHook(
        SESSION_ID,
        HookEventName.PreToolUse,
        'Bash',
        { type: HookType.Command, command: './skill-check.sh' },
        { skillRoot: '/project/.qwen/skills/check', trustGated },
      );
      return rows({ session, trusted })[0];
    }

    it('disables a trust-gated session hook in an untrusted folder', () => {
      const row = trustGatedRow(true, false);

      expect(row).toMatchObject({
        origin: 'session',
        enabled: false,
        disabledReason: 'untrusted',
        trustGated: true,
      });
    });

    it('enables a trust-gated session hook in a trusted folder', () => {
      const row = trustGatedRow(true, true);

      expect(row).toMatchObject({ enabled: true, trustGated: true });
      expect(row).not.toHaveProperty('disabledReason');
    });

    it('does not trust-gate a session hook that is not trust-gated', () => {
      const row = trustGatedRow(false, false);

      expect(row?.enabled).toBe(true);
      expect(row).not.toHaveProperty('trustGated');
    });
  });

  describe('agentScope', () => {
    it('carries the agent scope of an entry a subagent attached', async () => {
      const registry = await registryEntries({});
      registry.addAgentHooks(LINT_SETTINGS, 'agent-reviewer', {
        owner: { sessionId: 'session-1', agentId: 'agent-1' },
      });

      const [row] = rows({ entries: () => registry.getAllHooks() });

      expect(row).toMatchObject({
        origin: 'registry',
        source: HooksConfigSource.Session,
        agentScope: 'agent-reviewer',
      });
    });

    it('uses live source trust instead of the viewing workspace trust', async () => {
      const registry = await registryEntries({});
      let trusted = true;
      registry.addAgentHooks(LINT_SETTINGS, 'source-agent', {
        owner: { sessionId: SESSION_ID, agentId: 'A' },
        isSourceTrusted: () => trusted,
      });
      const config = makeConfig({
        entries: () => registry.getAllHooks(),
        trusted: false,
      });
      expect(buildHooksListing(config).rows[0]).toMatchObject({
        enabled: true,
        trustGated: true,
      });
      trusted = false;
      expect(buildHooksListing(config).rows[0]).toMatchObject({
        enabled: false,
        disabledReason: 'untrusted',
      });
      trusted = true;
      expect(buildHooksListing(config).rows[0].enabled).toBe(true);
    });

    it('omits agentScope on an entry from settings', async () => {
      const [row] = await lintRows();

      expect(row?.source).toBe(HooksConfigSource.User);
      expect(row).not.toHaveProperty('agentScope');
    });
  });

  describe('without a hook system', () => {
    const hook = (command: string) => ({
      [HookEventName.PreToolUse]: [
        { matcher: 'Bash', hooks: [{ type: HookType.Command, command }] },
      ],
    });

    it('lists every configured scope as disabled under disableAllHooks', () => {
      const listed = rows({
        hookSystem: false,
        disableAll: true,
        systemHooks: hook('./system.sh'),
        userHooks: hook('./user.sh'),
        projectHooks: hook('./project.sh'),
        extensions: [
          { isActive: true, hooks: hook('./extension.sh') },
          { isActive: false, hooks: hook('./inactive.sh') },
        ],
      });

      expect(
        listed.map((row) => [
          row.source,
          row.displayText,
          row.matcher,
          row.enabled,
          row.disabledReason,
        ]),
      ).toEqual([
        ['system', './system.sh', 'Bash', false, 'allHooksDisabled'],
        ['user', './user.sh', 'Bash', false, 'allHooksDisabled'],
        ['project', './project.sh', 'Bash', false, 'allHooksDisabled'],
        ['extensions', './extension.sh', 'Bash', false, 'allHooksDisabled'],
      ]);
    });

    it.each([
      ['safe', { safeMode: true }],
      ['bare', { bareMode: true }],
    ])('lists nothing in %s mode, which loads no hook settings', (_, mode) => {
      const config = makeConfig({
        hookSystem: false,
        disableAll: true,
        userHooks: hook('./user.sh'),
        ...mode,
      });

      const listing = buildHooksListing(config);

      expect(listing.rows).toEqual([]);
      expect(listing.safeMode || listing.bareMode).toBe(true);
      expect(config.getUserHooks).not.toHaveBeenCalled();
    });

    it('lists nothing when hooks are not disabled, e.g. before initialization', () => {
      const config = makeConfig({
        hookSystem: false,
        disableAll: false,
        userHooks: hook('./user.sh'),
      });

      expect(buildHooksListing(config).rows).toEqual([]);
      expect(config.getUserHooks).not.toHaveBeenCalled();
    });

    it('skips malformed settings for display without throwing', () => {
      const listed = rows({
        hookSystem: false,
        disableAll: true,
        userHooks: {
          enabled: true,
          NotAnEvent: [{ hooks: [{ type: 'command', command: './x.sh' }] }],
          [HookEventName.Stop]: 'not-an-array',
          [HookEventName.PreToolUse]: [
            null,
            { matcher: 'Bash' },
            {
              matcher: null,
              hooks: [
                { type: 'command', command: './null-matcher.sh', name: 42 },
              ],
            },
            {
              matcher: ['Read'],
              hooks: [{ type: 'command', command: './array-matcher.sh' }],
            },
            {
              hooks: [
                { type: 'command', command: {} },
                { type: 'unknown', command: './x.sh' },
                { type: 'function', id: 'no-callback' },
                'not-an-object',
              ],
            },
          ],
        },
      });

      expect(
        listed.map((row) => [row.displayText, row.matcher, row.name]),
      ).toEqual([
        ['./null-matcher.sh', undefined, '42'],
        ['./array-matcher.sh', undefined, undefined],
      ]);
    });

    it('collapses the duplicates the registry collapses', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './a.sh' }] },
          // Same command, event, matcher and sequential: one entry.
          { matcher: 'Bash', hooks: [{ type: 'command', command: './a.sh' }] },
          // Same name as an earlier hook: the name is the identity.
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: './b.sh', name: 'guard' },
              { type: 'command', command: './c.sh', name: 'guard' },
            ],
          },
        ],
      };
      const registry = await registryEntries(userHooks);

      const listed = rows({ hookSystem: false, disableAll: true, userHooks });

      const kept = registry
        .getAllHooks()
        .map((e) => (e.config as { command: string }).command);
      expect(kept).toEqual(['./a.sh', './b.sh']);
      expect(listed.map((row) => row.commandText)).toEqual(kept);
    });

    it('keeps the entries the registry keeps apart', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: './a.sh' }] },
          { matcher: 'Read', hooks: [{ type: 'command', command: './a.sh' }] },
          {
            matcher: 'Bash',
            sequential: true,
            hooks: [{ type: 'command', command: './a.sh' }],
          },
          { matcher: null, hooks: [{ type: 'command', command: './a.sh' }] },
          { hooks: [{ type: 'command', command: './a.sh' }] },
        ],
        [HookEventName.Stop]: [
          { hooks: [{ type: 'command', command: './a.sh' }] },
        ],
      };
      const registry = await registryEntries(userHooks);

      const listed = rows({
        hookSystem: false,
        disableAll: true,
        userHooks,
        extensions: [{ isActive: true, hooks: userHooks }],
      });

      expect(registry.getAllHooks()).toHaveLength(6);
      // Every user entry, then every extension entry: a different source is
      // never a duplicate.
      expect(listed).toHaveLength(12);
    });

    it('does not read settings when a hook system exists', () => {
      const config = makeConfig({
        disableAll: true,
        entries: () => [
          entry({ type: HookType.Command, command: './registry.sh' }),
        ],
        userHooks: hook('./user.sh'),
      });

      const listing = buildHooksListing(config);

      expect(listing.rows.map((row) => row.displayText)).toEqual([
        './registry.sh',
      ]);
      expect(config.getUserHooks).not.toHaveBeenCalled();
    });
  });
});
