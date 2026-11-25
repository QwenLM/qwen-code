/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoreEvent,
  coreEvents,
  HookRegistry,
  createHookConfigurationRef,
  type Config,
} from '@qwen-code/core';
import type { LoadedSettings } from './config/settings.js';
import {
  buildHookDiagnostics,
  createHookDiagnosticsPublisher,
} from './hookDiagnostics.js';
const flushBackground = () => new Promise<void>((resolve) => setImmediate(resolve));
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
async function fixture() {
  let hooks: unknown = { PreToolUse: [{ hooks: [{ type: 'command' }] }] };
  const settings = {
    errors: [],
    ...Object.fromEntries(
      ['user', 'project', 'local', 'flag'].map((source) => [
        source,
        {
          path: `/private/${source}.json`,
          settings: {},
          originalSettings: {},
        },
      ]),
    ),
  } as unknown as LoadedSettings;
  const config = {
    getSessionId: () => 'session-a',
    isSettingSourceAllowed: () => true,
    isTrustedFolder: () => true,
    getProjectHooks: () => undefined,
    getLocalHooks: () => undefined,
    getFlagHooks: () => undefined,
    getUserHooks: () => hooks,
    getEnabledPlugins: () => [],
    getBuiltinPluginContributions: () => undefined,
    getPluginErrors: () => [],
    getHookSystem: () => ({ getRegistry: () => registry }),
  } as unknown as Config;
  const registry = new HookRegistry(config);
  await registry.initialize({ emitToFeed: false });
  return {
    config,
    settings,
    registry,
    fix: () => {
      hooks = {};
    },
  };
}
describe('static Hook diagnostics', () => {
  it('reuses registry validation without registering invalid hooks', async () => {
    const { config, settings, registry } = await fixture();
    expect(registry.getHooksForEvent('PreToolUse' as never)).toEqual([]);
    expect(buildHookDiagnostics(config, settings)).toMatchObject({
      readStatus: 'complete',
      diagnostics: [
        {
          code: 'hook_validation_error',
          event: 'PreToolUse',
          message: 'Command hook missing command field',
        },
      ],
    });
    expect(
      JSON.stringify(buildHookDiagnostics(config, settings)),
    ).not.toContain('user config');
  });
  it('associates registry and recoverable field errors with the original settings row', async () => {
    const { config, settings } = await fixture();
    const original = { type: 'command', timeout: '${INVALID_TIMEOUT}' };
    settings.user.originalSettings.hooks = {
      PreToolUse: [{ hooks: [original] }],
    } as never;
    settings.errors.push({
      path: settings.user.path,
      severity: 'warning',
      message:
        'Ignored invalid setting "hooks.PreToolUse[0].hooks[0].timeout": Expected number, received string',
    });
    const expected = createHookConfigurationRef(
      'settings:user',
      'PreToolUse',
      0,
      0,
      original,
    );
    const snapshot = buildHookDiagnostics(config, settings);
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(
      snapshot.diagnostics.every(
        (diagnostic) => diagnostic.hook_ref === expected,
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('groupIndex');
  });
  it('does not expand validation rules', async () => {
    const { registry } = await fixture();
    expect(() =>
      registry.registerHook(
        { type: 'command', command: '  ' } as never,
        'PreToolUse' as never,
      ),
    ).not.toThrow();
  });
  it('includes field errors and incomplete loads without source details', async () => {
    const { config, settings } = await fixture();
    settings.user.loadRejected = true;
    settings.errors.push({
      path: settings.project.path,
      severity: 'warning',
      message:
        'Ignored invalid setting "hooks.PreToolUse[0].hooks[0].timeout": Expected number, received string',
    });
    vi.spyOn(config, 'getPluginErrors').mockReturnValue([
      {
        type: 'hook-load-failed',
        plugin: 'secret-plugin',
        source: 'manifest',
        hookPath: '/private/hooks.json',
        reason: 'secret/path',
      },
    ]);
    const snapshot = buildHookDiagnostics(config, settings);
    expect(snapshot.readStatus).toBe('partial');
    expect(snapshot.diagnostics).toHaveLength(4);
    expect(
      snapshot.diagnostics.some((d) => d.field?.endsWith('.timeout')),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private|secret-plugin|secret\/path/,
    );
  });
  it('starts after init, clears fixed issues, isolates sessions, reports failure and unsubscribes', async () => {
    const { config, settings, registry, fix } = await fixture();
    const publish = vi.fn();
    const publisher = createHookDiagnosticsPublisher({
      config,
      getSettings: () => settings,
      publish,
    });
    disposers.push(publisher.dispose);
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: 'session-a',
    });
    expect(publish).not.toHaveBeenCalled();
    publisher.start();
    publisher.start();
    expect(publish).not.toHaveBeenCalled();
    await flushBackground();
    expect(publish).toHaveBeenCalledTimes(1);
    fix();
    await registry.initialize({ emitToFeed: false });
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: 'session-b',
    });
    expect(publish).toHaveBeenCalledTimes(1);
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: 'session-a',
    });
    await flushBackground();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ readStatus: 'complete', diagnostics: [] }),
    );
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: 'session-a',
      failed: true,
    });
    await flushBackground();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ readStatus: 'failed' }),
    );
    publisher.dispose();
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, {
      sessionId: 'session-a',
    });
    await flushBackground();
    expect(publish).toHaveBeenCalledTimes(3);
  });
  it('defers collection and coalesces refreshes to the latest repaired state', async () => {
    const { config, settings, registry, fix } = await fixture();
    const getSettings = vi.fn(() => settings);
    const publish = vi.fn();
    const publisher = createHookDiagnosticsPublisher({ config, getSettings, publish });
    disposers.push(publisher.dispose);
    publisher.start();
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, { sessionId: 'session-a', failed: true });
    fix();
    await registry.initialize({ emitToFeed: false });
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, { sessionId: 'session-a' });
    // Even promise continuations complete before the background collection.
    expect(getSettings).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await flushBackground();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ readStatus: 'complete', diagnostics: [] }));
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, { sessionId: 'session-a' });
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, { sessionId: 'session-a', failed: true });
    await flushBackground();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ readStatus: 'failed' }));
  });
  it('cancels queued work on disposal', async () => {
    const { config, settings } = await fixture();
    const getSettings = vi.fn(() => settings);
    const publish = vi.fn();
    const publisher = createHookDiagnosticsPublisher({ config, getSettings, publish });
    publisher.start();
    publisher.dispose();
    await flushBackground();
    expect(getSettings).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it.each(['collection', 'publication'])('isolates %s failures and retries on the next refresh', async (stage) => {
    const { config, settings } = await fixture();
    const getSettings = vi.fn(() => settings);
    const publish = vi.fn();
    const fail = () => { throw new Error('fixture failure'); };
    if (stage === 'collection') getSettings.mockImplementationOnce(fail);
    else publish.mockImplementationOnce(fail);
    const publisher = createHookDiagnosticsPublisher({ config, getSettings, publish });
    disposers.push(publisher.dispose);
    expect(() => publisher.start()).not.toThrow();
    await flushBackground();
    coreEvents.emit(CoreEvent.HookDiagnosticsChanged, { sessionId: 'session-a' });
    await flushBackground();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ readStatus: 'complete' }));
  });

});
