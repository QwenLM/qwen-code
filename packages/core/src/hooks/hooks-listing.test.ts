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
  };
}

describe('buildHooksListing', () => {
  it('flattens each hook type into its identity and literal text', () => {
    const longPrompt = 'x'.repeat(60);
    const listing = buildHooksListing(
      makeConfig({
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
      }),
    );

    expect(
      listing.rows.map((row) => [
        row.hookType,
        row.displayText,
        row.commandText,
      ]),
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
    const [row] = buildHooksListing(
      makeConfig({
        entries: () => [
          entry({ type: HookType.Command, command: 'sleep 1', async: true }),
        ],
      }),
    ).rows;

    expect(row?.runsInBackground).toBe(true);
    expect(row).not.toHaveProperty('runsOnce');
  });

  it('carries an HTTP hook once flag and its if condition', () => {
    const [row] = buildHooksListing(
      makeConfig({
        entries: () => [
          entry({
            type: HookType.Http,
            url: 'https://hooks.example.com/once',
            once: true,
            if: 'Bash(git *)',
          }),
        ],
      }),
    ).rows;

    expect(row?.runsOnce).toBe(true);
    expect(row?.condition).toBe('Bash(git *)');
    expect(row).not.toHaveProperty('runsInBackground');
  });

  it('reads timeout and statusMessage from every hook type', () => {
    const listing = buildHooksListing(
      makeConfig({
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
      }),
    );

    expect(listing.rows.map((row) => [row.timeout, row.statusMessage])).toEqual(
      [
        [5, 'Linting…'],
        [6, 'Auditing…'],
        [7, 'Checking goal…'],
        [8, 'Judging…'],
      ],
    );
  });

  it('reports the registry enabled state instead of assuming enabled', async () => {
    const registry = new HookRegistry({
      getProjectRoot: () => '/project',
      isTrustedFolder: () => true,
      getUserHooks: () => ({
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              { type: HookType.Command, command: './lint.sh', name: 'lint' },
            ],
          },
        ],
      }),
      getProjectHooks: () => undefined,
      getExtensions: () => [],
    });
    await registry.initialize();
    registry.setHookEnabled('lint', false);

    const [row] = buildHooksListing(
      makeConfig({ entries: () => registry.getAllHooks() }),
    ).rows;

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

    const listing = buildHooksListing(
      makeConfig({
        session,
        entries: () => [
          entry({ type: HookType.Command, command: './lint.sh' }),
        ],
      }),
    );

    expect(listing.rows.map((row) => row.displayText)).toEqual([
      './lint.sh',
      'goal-stop-hook',
    ]);
    const sessionRow = listing.rows[1];
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
    const [row] = buildHooksListing(
      makeConfig({
        entries: () => [
          entry(
            { type: HookType.Command, command: './agent-hook.sh' },
            { source: HooksConfigSource.Session, agentScope: 'agent-1' },
          ),
        ],
      }),
    ).rows;

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

  it('returns no rows without a hook system', () => {
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
    const listing = buildHooksListing(
      makeConfig({
        entries: () => [
          entry({ type: HookType.Command, command: 'a' }, { matcher: '' }),
          entry(
            { type: HookType.Command, command: 'b' },
            { matcher: 'Write|Edit', sequential: true },
          ),
        ],
      }),
    );

    expect(listing.rows[0]).not.toHaveProperty('matcher');
    expect(listing.rows[1]).toMatchObject({
      matcher: 'Write|Edit',
      sequential: true,
    });
  });
});
