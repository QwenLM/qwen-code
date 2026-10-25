/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../config/settings.js';
import type { ModTerminalHost } from './mod-session.js';
import {
  createInteractiveModSession,
  getInteractiveModSession,
  type InteractiveModSession,
} from './interactive-mod-session.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('./mod-session.js', () => ({ ModSession: { create: mocks.create } }));

describe('interactive Mod owner', () => {
  const owners: InteractiveModSession[] = [];
  const settings = {
    merged: { experimental: { mods: true } },
  } as LoadedSettings;

  function setup() {
    const config = {
      isInteractive: () => true,
      getSessionId: vi.fn(() => 'old'),
    } as unknown as Config;
    const runtime = {
      initialize: vi.fn().mockResolvedValue(undefined),
      loadCommands: vi.fn().mockResolvedValue([]),
      flushLogs: vi.fn(),
      syncSession: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mocks.create.mockReturnValue(runtime);
    const owner = createInteractiveModSession(config, settings)!;
    owners.push(owner);
    const host = mocks.create.mock.lastCall![2] as ModTerminalHost;
    return { config, runtime, owner, host };
  }

  afterEach(async () => {
    await Promise.all(owners.splice(0).map((owner) => owner.close()));
    vi.resetAllMocks();
  });

  it('creates one opt-in owner per exact interactive Config', async () => {
    expect(
      createInteractiveModSession(
        {} as Config,
        { merged: {} } as LoadedSettings,
      ),
    ).toBeUndefined();
    expect(
      createInteractiveModSession(
        { isInteractive: () => false } as Config,
        settings,
      ),
    ).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
    const first = setup();
    expect(createInteractiveModSession(first.config, settings)).toBe(
      first.owner,
    );
    const second = setup();
    expect(getInteractiveModSession(first.config)).toBe(first.owner);
    expect(getInteractiveModSession(second.config)).toBe(second.owner);
    expect(getInteractiveModSession({} as Config)).toBeUndefined();
    await first.owner.close();
    expect(getInteractiveModSession(first.config)).toBeUndefined();
    expect(getInteractiveModSession(second.config)).toBe(second.owner);
  });

  it('holds command discovery until config startup and survives loader refresh cancellation', async () => {
    const { owner, runtime } = setup();
    const loader = new AbortController();
    const abandoned = owner.loadCommands(loader.signal);
    const rejected = abandoned.catch((error: unknown) => error);
    await Promise.resolve();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.loadCommands).not.toHaveBeenCalled();
    loader.abort();
    await Promise.all([owner.initialize(), owner.initialize()]);
    expect(await rejected).toBeInstanceOf(Error);
    await owner.loadCommands(new AbortController().signal);
    expect(runtime.initialize).toHaveBeenCalledOnce();
    const lifetime = runtime.initialize.mock.calls[0][0] as AbortSignal;
    expect(lifetime.aborted).toBe(false);
    expect(runtime.loadCommands).toHaveBeenCalledExactlyOnceWith(lifetime);
    await owner.close();
    expect(lifetime.aborted).toBe(true);
  });

  it('retains a visible startup failure and never exposes commands after it', async () => {
    const { owner, runtime } = setup();
    const logs = vi.fn();
    owner.subscribe(logs);
    runtime.initialize.mockRejectedValue(new Error('tool.call is unsupported'));
    await expect(owner.initialize()).rejects.toThrow('tool.call');
    await expect(
      owner.loadCommands(new AbortController().signal),
    ).rejects.toThrow('tool.call');
    await expect(owner.initialize()).rejects.toThrow('tool.call');
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(runtime.loadCommands).not.toHaveBeenCalled();
    expect(logs).toHaveBeenCalledExactlyOnceWith(
      'Mods failed to initialize: Error: tool.call is unsupported',
    );
  });

  it('rejects pending discovery permanently when the host fails before Mod startup', async () => {
    const { config, owner, runtime } = setup();
    const error = new Error('Transcript restore failed');
    const commands = owner.loadCommands(new AbortController().signal);
    const rejected = commands.catch((reason: unknown) => reason);

    owner.failStartup(error);

    await expect(owner.ready).rejects.toBe(error);
    expect(await rejected).toBe(error);
    await expect(owner.initialize()).rejects.toBe(error);
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(runtime.loadCommands).not.toHaveBeenCalled();
    expect(getInteractiveModSession(config)).toBe(owner);
  });

  it('leaves Mod readiness intact when later host recovery fails', async () => {
    const { owner, runtime } = setup();
    let release!: () => void;
    runtime.initialize.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const initialization = owner.initialize();
    owner.failStartup(new Error('Background recovery failed'));
    release();

    await initialization;
    await expect(owner.ready).resolves.toBeUndefined();
    owner.failStartup(new Error('Later recovery failed'));
    await owner.loadCommands(new AbortController().signal);
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(runtime.loadCommands).toHaveBeenCalledOnce();
  });

  it('buffers current transcript logs across renderer attachment and drops old-session output', () => {
    const { owner, host, config } = setup();
    host.log({ to: 'transcript', text: 'stale' }, 'mod', 'old');
    vi.mocked(config.getSessionId).mockReturnValue('new');
    host.log({ to: 'transcript', text: 'current' }, 'mod', 'new');
    const first = vi.fn();
    const detachFirst = owner.subscribe(first);
    expect(first).toHaveBeenCalledExactlyOnceWith('[Mod mod] current');
    const second = vi.fn();
    owner.subscribe(second);
    detachFirst();
    host.log({ to: 'transcript', text: 'late old' }, 'mod', 'old');
    host.log({ to: 'transcript', text: 'next' }, 'mod', 'new');
    expect(second).toHaveBeenCalledExactlyOnceWith('[Mod mod] next');
    owner.setPresentation({ isFullscreen: true, columns: 120 });
    expect(host.presentation()).toEqual({ isFullscreen: true, columns: 120 });
  });

  it('sanitizes plugin labels and startup errors without flattening transcript logs', async () => {
    const { owner, host, runtime } = setup();
    const logs = vi.fn();
    owner.subscribe(logs);
    host.log(
      { to: 'transcript', text: 'line one\nline two\tvalue' },
      'bad\nname\u202e',
      'old',
    );
    expect(logs).toHaveBeenCalledWith(
      '[Mod bad name] line one\nline two\tvalue',
    );
    runtime.initialize.mockRejectedValue(new Error('bad\nconfig\u2066'));
    await expect(owner.initialize()).rejects.toThrow('bad');
    expect(logs).toHaveBeenLastCalledWith(
      'Mods failed to initialize: Error: bad config',
    );
  });

  it('closing before startup releases pending command loaders and removes the owner', async () => {
    const { config, owner, runtime } = setup();
    const commands = owner.loadCommands(new AbortController().signal);
    const rejected = commands.catch((error: unknown) => error);
    await Promise.all([owner.close(), owner.close()]);
    expect(await rejected).toBeInstanceOf(Error);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(runtime.initialize).not.toHaveBeenCalled();
    expect(getInteractiveModSession(config)).toBeUndefined();
  });
});
