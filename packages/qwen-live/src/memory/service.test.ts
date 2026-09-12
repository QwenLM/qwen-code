/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMemoryConfig } from './config.js';
import type { MemorySession } from './session.js';
import {
  MemoryService,
  persistMemoryPreferences,
  type MemoryServiceOptions,
} from './service.js';
import { MemoryStore } from './store.js';
import { displayLiveMessage, liveMessage } from '../i18n/messages.js';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, renameSync: vi.fn(original.renameSync) };
});

const fixtures: Array<{
  root: string;
  services: MemoryService[];
  sessions: MemorySession[];
}> = [];
function fixture(
  rawMemory: Record<string, unknown> = {},
  persist = true,
  extras: Partial<MemoryServiceOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-memory-service-'));
  const dataDir = join(root, 'live-data');
  const configPath = join(dataDir, 'config.json');
  const raw = {
    realtime: {
      apiKey: 'fixture-secret-key',
      endpoint: 'wss://realtime.example.test/api-ws/v1/realtime',
    },
    customTopLevel: { keep: [1, 2, 3] },
    memory: { retrieve: { useVector: false }, ...rawMemory },
  };
  if (persist) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw));
  }
  const owned = {
    root,
    services: [] as MemoryService[],
    sessions: [] as MemorySession[],
  };
  fixtures.push(owned);
  const create = () => {
    const current = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, 'utf8')) as { memory?: unknown })
      : raw;
    const service = new MemoryService({
      config: resolveMemoryConfig(current.memory, dataDir, configPath),
      dataDir,
      connection: { baseUrl: 'https://memory.example.test/v1' },
      ...extras,
    });
    owned.services.push(service);
    return service;
  };
  const attach = (
    service: MemoryService,
    sessionId = 'call-1',
    captureVision: () => Promise<
      { image: string; source: 'camera' } | undefined
    > = async () => undefined,
  ) => {
    const session = service.attach({
      sessionId,
      visualSource: 'camera',
      captureVision,
    });
    if (session) owned.sessions.push(session);
    return session;
  };
  return { root, dataDir, configPath, raw, create, attach };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const owned of fixtures.splice(0)) {
    owned.sessions.forEach((session) => session.close());
    await Promise.all(owned.services.map((service) => service.close()));
    rmSync(owned.root, { recursive: true, force: true });
  }
  vi.mocked(renameSync).mockClear();
});

describe('persistMemoryPreferences', () => {
  it('updates UTF-8 BOM configurations while retaining unrelated fields', () => {
    const { dataDir, configPath, raw } = fixture({
      updater: { timeoutMs: 4567 },
      observer: { intervalSec: 12 },
    });
    writeFileSync(configPath, `\uFEFF${JSON.stringify(raw)}`);
    const resolved = persistMemoryPreferences(dataDir, {
      enabled: false,
      defaultId: 'work',
      model: 'custom-memory-model',
      visualEnabled: true,
    });
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.realtime).toEqual(raw.realtime);
    expect(saved.customTopLevel).toEqual(raw.customTopLevel);
    expect(saved.memory).toMatchObject({
      enabled: false,
      defaultId: 'work',
      updater: { timeoutMs: 4567, model: 'custom-memory-model' },
      observer: { intervalSec: 12, enabled: true },
      retrieve: { useVector: false },
    });
    expect(resolved.updater.model).toBe('custom-memory-model');
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  it('retains a failed session finish and blocks duplicate attachment until its persistence recovers', async () => {
    const { create, attach } = fixture();
    const service = create();
    const session = attach(service)!;
    const close = vi.spyOn(session, 'close').mockImplementation(() => {
      throw new Error('Disk temporarily unavailable');
    });
    service.finish(session);
    expect(attach(service)).toBeUndefined();
    const closeStore = vi.spyOn(MemoryStore.prototype, 'close');
    await expect(service.close()).rejects.toThrow();
    expect(closeStore).not.toHaveBeenCalled();
    expect(service.state().error).toMatch(/storage/);
    close.mockRestore();
    await service.close();
    expect(closeStore).toHaveBeenCalledOnce();
    closeStore.mockRestore();
  });

  it('atomically merges only UI preferences while preserving credentials and unrelated config', () => {
    const { dataDir, configPath, raw } = fixture({
      updater: { timeoutMs: 4567 },
      observer: { intervalSec: 12 },
    });
    const resolved = persistMemoryPreferences(dataDir, {
      enabled: false,
      defaultId: 'work',
      model: 'custom-memory-model',
      visualEnabled: true,
    });
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.realtime).toEqual(raw.realtime);
    expect(saved.customTopLevel).toEqual(raw.customTopLevel);
    expect(saved.memory).toMatchObject({
      enabled: false,
      defaultId: 'work',
      updater: { timeoutMs: 4567, model: 'custom-memory-model' },
      observer: { intervalSec: 12, enabled: true },
      retrieve: { useVector: false },
    });
    expect(saved.memory.observer).not.toHaveProperty('model');
    expect(resolved.observer.model).toBe('custom-memory-model');
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  // Windows has no POSIX permission bits, so skip (reportedly) rather than
  // passing a test that asserted nothing.
  it.skipIf(process.platform === 'win32')(
    'writes the memory config with 0600 permissions',
    () => {
      const plain = fixture();
      persistMemoryPreferences(plain.dataDir, { enabled: false });
      expect(statSync(plain.configPath).mode & 0o777).toBe(0o600);
      const bom = fixture();
      writeFileSync(bom.configPath, `\uFEFF${JSON.stringify(bom.raw)}`);
      persistMemoryPreferences(bom.dataDir, { enabled: false });
      expect(statSync(bom.configPath).mode & 0o777).toBe(0o600);
    },
  );

  it('leaves the original file untouched and cleans its temporary file when replacement fails', () => {
    const { dataDir, configPath } = fixture();
    const before = readFileSync(configPath, 'utf8');
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('fixture rename failure');
    });
    expect(() => persistMemoryPreferences(dataDir, { enabled: false })).toThrow(
      'fixture rename failure',
    );
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(readdirSync(dataDir)).toEqual(['config.json']);
  });

  it('rejects an invalid UI preference before writing any bytes', () => {
    const { dataDir, configPath } = fixture();
    const before = readFileSync(configPath, 'utf8');
    expect(() =>
      persistMemoryPreferences(dataDir, { defaultId: '../escape' }),
    ).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each([
    { memory: ['user-edited-invalid-value'], patch: { enabled: false } },
    { memory: null, patch: { enabled: false } },
    { memory: { updater: ['invalid-updater'] }, patch: { model: 'model' } },
    {
      memory: { observer: 'invalid-observer' },
      patch: { visualEnabled: true },
    },
  ])(
    'preserves malformed existing memory config instead of silently replacing it: %j',
    ({ memory, patch }) => {
      const { dataDir, configPath } = fixture();
      const original = JSON.stringify({
        realtime: { apiKey: 'fixture-key' },
        memory,
      });
      writeFileSync(configPath, original);
      expect(() => persistMemoryPreferences(dataDir, patch)).toThrow();
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    },
  );
});

describe('MemoryService UI preferences', () => {
  it('does not create a library or data directory while memory is disabled', () => {
    const { dataDir, create, attach } = fixture({ enabled: false }, false);
    const service = create();
    expect(service.state()).toMatchObject({
      enabled: false,
      visualEnabled: false,
      libraryId: 'default',
      libraries: [],
    });
    expect(attach(service)).toBeUndefined();
    expect(existsSync(dataDir)).toBe(false);
  });

  it('creates a default library when enabled and resolves a missing selection without creating a phantom library', () => {
    const { create, attach } = fixture({ defaultId: 'missing-library' });
    const service = create();
    expect(service.state()).toMatchObject({
      enabled: true,
      libraryId: 'default',
      libraries: [{ id: 'default', name: 'Default Memory' }],
    });
    expect(displayLiveMessage('en', service.state().error ?? '')).toContain(
      'Selected memory is unavailable',
    );
    expect(attach(service)?.libraryId).toBe('default');
    expect(
      service
        .state()
        .libraries.some((library) => library.id === 'missing-library'),
    ).toBe(false);
  });

  it('retains selection across a disabled period and restart, and enables the chosen library', async () => {
    const { create, attach } = fixture();
    const first = create();
    const workId = first.applyAction({
      action: 'create',
      name: 'Work Memory',
    }).libraryId;
    first.applyAction({ action: 'set_enabled', enabled: false });
    first.applyAction({ action: 'select', libraryId: 'default' });
    first.applyAction({ action: 'select', libraryId: workId });
    await first.close();
    const second = create();
    expect(second.state()).toMatchObject({ enabled: false, libraryId: workId });
    expect(attach(second)).toBeUndefined();
    second.applyAction({ action: 'set_enabled', enabled: true });
    expect(attach(second)?.libraryId).toBe(workId);
  });

  it('locks library/model changes during a call while allowing toggles and rename without changing identity', () => {
    const { create } = fixture();
    const service = create();
    service.setLocked(true);
    for (const action of [
      { action: 'select', libraryId: 'default' },
      { action: 'create', name: 'Blocked' },
      { action: 'set_model', model: 'blocked-model' },
    ] as const) {
      expect(() => service.applyAction(action)).toThrow(
        liveMessage('memoryUI.locked'),
      );
    }
    service.applyAction({
      action: 'rename',
      libraryId: 'default',
      name: 'Personal Memory',
    });
    service.applyAction({ action: 'set_visual_enabled', enabled: true });
    service.applyAction({ action: 'set_enabled', enabled: false });
    expect(service.state()).toMatchObject({
      libraryId: 'default',
      enabled: false,
      visualEnabled: true,
      locked: true,
      libraries: [{ id: 'default', name: 'Personal Memory' }],
    });
  });

  it('changes the shared memory model when idle and preserves an explicit observer model', () => {
    const { create } = fixture({ observer: { model: 'explicit-observer' } });
    const service = create();
    service.applyAction({ action: 'set_model', model: 'new-updater' });
    expect(service.settings.updater.model).toBe('new-updater');
    expect(service.settings.observer.model).toBe('explicit-observer');
    const copy = service.settings;
    copy.updater.model = 'mutated';
    expect(service.state().model).toBe('new-updater');
    const state = service.state();
    state.libraries[0]!.name = 'mutated';
    expect(service.state().libraries[0]?.name).toBe('Default Memory');
  });

  it('rejects a nonexistent library and invalid rename without persisting an unrelated change', () => {
    const { create, configPath } = fixture();
    const service = create();
    const original = readFileSync(configPath, 'utf8');
    expect(() =>
      service.applyAction({ action: 'select', libraryId: 'missing' }),
    ).toThrow();
    expect(() =>
      service.applyAction({ action: 'rename', libraryId: 'default', name: '' }),
    ).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(service.state().libraryId).toBe('default');
  });
});

describe('MemoryService attachment and shutdown', () => {
  it('consolidates an active attachment once when shutdown finishes its final persistence', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"ltm_patch":{"set":{"name":"Ada"}}}' } },
            ],
          }),
        ),
    );
    const { create, attach } = fixture({}, true, {
      connection: {
        baseUrl: 'https://memory.example.test/v1',
        apiKey: 'fixture-key',
      },
      fetch: fetcher,
    });
    const service = create();
    const session = attach(service)!;
    session.applyOmnibio({ add: ['User is Ada.'] });
    await service.close();
    expect(fetcher).toHaveBeenCalledOnce();
    const store = new MemoryStore({
      directory: service.settings.dir,
      defaultId: 'default',
    });
    try {
      expect(
        store
          .database('default')
          .prepare('SELECT COUNT(*) AS n FROM updater_log')
          .get()?.['n'],
      ).toBe(1);
    } finally {
      store.close();
    }
  });

  it('restores WM after off/on reattach and consolidates each version once', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"ltm_patch":{"set":{"name":"小王"}}}' } },
            ],
          }),
        ),
    );
    const { create, attach } = fixture({}, true, {
      connection: {
        baseUrl: 'https://memory.example.test/v1',
        apiKey: 'fixture-key',
      },
      fetch: fetcher,
    });
    const service = create();
    const first = attach(service)!;
    first.recordUser('我叫小王');
    first.recordAssistant('你好，小王。');
    first.applyOmnibio({ add: ['用户叫小王。'] });
    service.applyAction({ action: 'set_enabled', enabled: false });
    service.finish(first);
    service.finish(first);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    service.applyAction({ action: 'set_enabled', enabled: true });
    const second = attach(service)!;
    expect(second.wmEntries).toEqual(['用户叫小王。']);
    second.applyOmnibio({ add: ['用户喜欢园艺。'] });
    service.finish(second);
    await service.close();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const store = new MemoryStore({
      directory: service.settings.dir,
      defaultId: 'default',
    });
    try {
      const db = store.database('default');
      expect(
        db
          .prepare('SELECT session_id FROM updater_log ORDER BY session_id')
          .all()
          .map((row) => row['session_id']),
      ).toEqual(['call-1#wm_1', 'call-1#wm_2']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM turns').get()?.['n']).toBe(
        1,
      );
    } finally {
      store.close();
    }
  });

  it('aborts a late updater response before closing storage and never writes the late patch', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const logs = vi.fn();
    const { create, attach } = fixture(
      { updater: { shutdownWaitSec: 0 } },
      true,
      {
        connection: {
          baseUrl: 'https://memory.example.test/v1',
          apiKey: 'fixture-key',
        },
        fetch: fetcher,
        log: logs,
      },
    );
    const service = create();
    const session = attach(service)!;
    session.applyOmnibio({ add: ['用户叫小王。'] });
    service.finish(session);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await service.close();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"ltm_patch":{"set":{"name":"must not write"}}}',
              },
            },
          ],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const store = new MemoryStore({
      directory: service.settings.dir,
      defaultId: 'default',
    });
    try {
      expect(
        store
          .database('default')
          .prepare('SELECT COUNT(*) AS n FROM ltm_entries')
          .get()?.['n'],
      ).toBe(0);
      expect(
        store
          .database('default')
          .prepare('SELECT COUNT(*) AS n FROM wm_snapshots')
          .get()?.['n'],
      ).toBe(1);
    } finally {
      store.close();
    }
    expect(logs).toHaveBeenCalledWith('memory.updater.shutdown_abandoned');
  });

  it('closes attached sessions and stops their observation loops during service shutdown', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '用户在书桌旁阅读。' } }],
          }),
        ),
    );
    const capture = vi.fn(async () => ({
      image: 'fixture-frame',
      source: 'camera' as const,
    }));
    const { create, attach } = fixture({ observer: { enabled: true } }, true, {
      connection: {
        baseUrl: 'https://memory.example.test/v1',
        apiKey: 'fixture-key',
      },
      fetch: fetcher,
    });
    const service = create();
    const session = attach(service, 'call-1', capture)!;
    session.startObserver();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
    await service.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(session.closed).toBe(true);
  });

  it('retries database closure without reopening a closed Memory service or its sessions', async () => {
    const { create, attach } = fixture();
    const service = create();
    const session = attach(service)!;
    const closeSession = vi.spyOn(session, 'close');
    const closeStore = vi
      .spyOn(MemoryStore.prototype, 'close')
      .mockImplementationOnce(() => {
        throw new Error('Store is busy');
      });
    try {
      const first = service.close();
      expect(service.close()).toBe(first);
      await expect(first).rejects.toThrow('Store is busy');
      expect(session.closed).toBe(true);
      expect(attach(service, 'late-call')).toBeUndefined();
      expect(() =>
        service.applyAction({ action: 'set_enabled', enabled: true }),
      ).toThrow('closed');
      await service.close();
      await service.close();
      expect(closeStore).toHaveBeenCalledTimes(2);
      expect(closeSession).toHaveBeenCalledOnce();
    } finally {
      closeStore.mockRestore();
    }
  });
});
