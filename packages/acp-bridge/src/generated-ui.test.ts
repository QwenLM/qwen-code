/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { SERVE_STATUS_EXT_METHODS, STATUS_SCHEMA_VERSION } from './status.js';

const enabled = { version: 1, enabled: true };
const disabled = { version: 1, enabled: false, reason: 'policy-disabled' };
const contextStatus = (sessionId: string, generatedUi: unknown) => ({
  v: STATUS_SCHEMA_VERSION,
  sessionId,
  state: { _meta: { generatedUi } },
});

describe('owning-session Generated UI state', () => {
  it('refreshes fresh-session and single-scope late attaches from their owner', async () => {
    let status = enabled;
    const channel = makeChannel({
      newSessionImpl: () => ({
        sessionId: 'ui-owner',
        _meta: { generatedUi: enabled },
      }),
      extMethodImpl: (_method, params) =>
        contextStatus(String(params['sessionId']), status),
    });
    const bridge = makeBridge({
      sessionScope: 'single',
      channelFactory: async () => channel.channel,
    });
    try {
      const created = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(created.generatedUi).toEqual(enabled);
      status = disabled;
      const attached = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(attached.attached).toBe(true);
      expect(attached.generatedUi).toEqual(disabled);
      const loaded = await bridge.loadSession({
        sessionId: created.sessionId,
        workspaceCwd: WS_A,
      });
      expect(loaded.generatedUi).toEqual(disabled);
      expect(channel.agent.loadSessionCalls).toHaveLength(0);
      expect(channel.agent.resumeSessionCalls).toHaveLength(0);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each(['loadSession', 'resumeSession'] as const)(
    'refreshes %s receipts and stored metadata without changing models',
    async (method) => {
      let status = enabled;
      const state = {
        _meta: { generatedUi: enabled, preserved: 'value' },
        models: { currentModelId: 'original-model', availableModels: [] },
      };
      const channel = makeChannel({
        loadSessionImpl: () => state,
        resumeSessionImpl: () => state,
        extMethodImpl: (_method, params) => ({
          ...contextStatus(String(params['sessionId']), status),
          state: {
            _meta: { generatedUi: status },
            models: { currentModelId: 'status-only-model' },
          },
        }),
      });
      const bridge = makeBridge({
        channelFactory: async () => channel.channel,
      });
      try {
        const restored = await bridge[method]({
          sessionId: 'ui-history',
          workspaceCwd: WS_A,
        });
        expect(restored.generatedUi).toEqual(enabled);
        status = disabled;
        const attached = await bridge[method]({
          sessionId: 'ui-history',
          workspaceCwd: WS_A,
        });
        expect(attached.generatedUi).toEqual(disabled);
        expect(attached.state).toMatchObject({
          _meta: { generatedUi: disabled, preserved: 'value' },
          models: { currentModelId: 'original-model' },
        });
        expect(
          channel.agent.loadSessionCalls.length +
            channel.agent.resumeSessionCalls.length,
        ).toBe(1);
        status = enabled;
        expect(
          (
            await bridge[method]({
              sessionId: 'ui-history',
              workspaceCwd: WS_A,
            })
          ).generatedUi,
        ).toEqual(enabled);
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it.each([
    ['missing receipt', { v: 1, sessionId: 'ui-history', state: {} }],
    [
      'unknown feature version',
      contextStatus('ui-history', { version: 2, enabled: true }),
    ],
    [
      'invalid enabled type',
      contextStatus('ui-history', { version: 1, enabled: 'true' }),
    ],
    ['different owner', contextStatus('other-owner', enabled)],
    [
      'unknown status version',
      { ...contextStatus('ui-history', enabled), v: 2 },
    ],
    [
      'untrusted top-level receipt',
      { v: 1, sessionId: 'ui-history', generatedUi: enabled, state: {} },
    ],
    ['failed read', new Error('status unavailable')],
  ])(
    'clears both cached receipts on %s and retries on a later attach',
    async (_label, invalid) => {
      let response: Record<string, unknown> | Error = contextStatus(
        'ui-history',
        enabled,
      );
      const bridge = makeBridge({
        channelFactory: async () =>
          makeChannel({
            loadSessionImpl: () => ({
              _meta: { generatedUi: enabled, preserved: true },
            }),
            extMethodImpl: () => {
              if (response instanceof Error) throw response;
              return response;
            },
          }).channel,
      });
      try {
        await bridge.loadSession({
          sessionId: 'ui-history',
          workspaceCwd: WS_A,
        });
        response = invalid;
        const attached = await bridge.resumeSession({
          sessionId: 'ui-history',
          workspaceCwd: WS_A,
        });
        expect(attached.generatedUi).toBeUndefined();
        expect(attached.state._meta).not.toHaveProperty('generatedUi');
        expect(attached.state._meta).toHaveProperty('preserved', true);
        response = contextStatus('ui-history', enabled);
        expect(
          (
            await bridge.loadSession({
              sessionId: 'ui-history',
              workspaceCwd: WS_A,
            })
          ).generatedUi,
        ).toEqual(enabled);
      } finally {
        await bridge.shutdown();
      }
    },
  );

  it('does not inherit a restore owner receipt when a coalesced attach cannot validate it', async () => {
    let releaseRestore:
      | ((value: { _meta: { generatedUi: typeof enabled } }) => void)
      | undefined;
    let reads = 0;
    const bridge = makeBridge({
      channelFactory: async () =>
        makeChannel({
          loadSessionImpl: () =>
            new Promise((resolve) => {
              releaseRestore = resolve;
            }),
          extMethodImpl: () =>
            ++reads === 1 ? contextStatus('ui-coalesced', enabled) : {},
        }).channel,
    });
    try {
      const owner = bridge.loadSession({
        sessionId: 'ui-coalesced',
        workspaceCwd: WS_A,
      });
      await vi.waitFor(() => expect(releaseRestore).toBeDefined());
      const waiter = bridge.loadSession({
        sessionId: 'ui-coalesced',
        workspaceCwd: WS_A,
      });
      releaseRestore!({ _meta: { generatedUi: enabled } });
      expect((await owner).generatedUi).toEqual(enabled);
      const attached = await waiter;
      expect(attached.generatedUi).toBeUndefined();
      expect(attached.state._meta).not.toHaveProperty('generatedUi');
    } finally {
      await bridge.shutdown();
    }
  });

  it('does not fall back to a fresh enabled seed when its owner read fails', async () => {
    const bridge = makeBridge({
      channelFactory: async () =>
        makeChannel({
          newSessionImpl: () => ({
            sessionId: 'ui-fresh',
            _meta: { generatedUi: enabled },
          }),
          extMethodImpl: () => {
            throw new Error('status unavailable');
          },
        }).channel,
    });
    try {
      expect(
        (await bridge.spawnOrAttach({ workspaceCwd: WS_A })).generatedUi,
      ).toBeUndefined();
    } finally {
      await bridge.shutdown();
    }
  });

  it('clears enabled state after a bounded status timeout', async () => {
    let hung = false;
    let resolveHung: ((value: Record<string, unknown>) => void) | undefined;
    const bridge = makeBridge({
      initializeTimeoutMs: 100,
      channelFactory: async () =>
        makeChannel({
          loadSessionImpl: () => ({ _meta: { generatedUi: enabled } }),
          extMethodImpl: () =>
            hung
              ? new Promise((resolve) => {
                  resolveHung = resolve;
                })
              : contextStatus('ui-timeout', enabled),
        }).channel,
    });
    try {
      await bridge.loadSession({ sessionId: 'ui-timeout', workspaceCwd: WS_A });
      hung = true;
      const attached = await bridge.resumeSession({
        sessionId: 'ui-timeout',
        workspaceCwd: WS_A,
      });
      expect(attached.generatedUi).toBeUndefined();
      expect(attached.state._meta).not.toHaveProperty('generatedUi');
    } finally {
      resolveHung?.(contextStatus('ui-timeout', enabled));
      await bridge.shutdown();
    }
  });

  it('does not overwrite a newer restricted receipt with an older enabled response', async () => {
    let probe = false;
    let reads = 0;
    let resolveOld: ((value: Record<string, unknown>) => void) | undefined;
    const bridge = makeBridge({
      channelFactory: async () =>
        makeChannel({
          loadSessionImpl: () => ({ _meta: { generatedUi: enabled } }),
          extMethodImpl: () => {
            if (!probe) return contextStatus('ui-race', enabled);
            if (++reads === 1)
              return new Promise((resolve) => {
                resolveOld = resolve;
              });
            return contextStatus('ui-race', disabled);
          },
        }).channel,
    });
    try {
      await bridge.loadSession({ sessionId: 'ui-race', workspaceCwd: WS_A });
      probe = true;
      const older = bridge.loadSession({
        sessionId: 'ui-race',
        workspaceCwd: WS_A,
      });
      await vi.waitFor(() => expect(resolveOld).toBeDefined());
      expect(
        (
          await bridge.resumeSession({
            sessionId: 'ui-race',
            workspaceCwd: WS_A,
          })
        ).generatedUi,
      ).toEqual(disabled);
      resolveOld!(contextStatus('ui-race', enabled));
      const stale = await older;
      expect(stale.generatedUi).toEqual(disabled);
      expect(stale.state._meta?.['generatedUi']).toEqual(disabled);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each([
    undefined,
    { version: 2, enabled: true },
    { version: 1, enabled: 'true' },
  ])(
    'fails closed without probing a missing or unknown seed: %j',
    async (generatedUi) => {
      const channel = makeChannel({
        newSessionImpl: () => ({
          sessionId: 'ui-unknown',
          _meta: { generatedUi },
        }),
        extMethodImpl: () => contextStatus('ui-unknown', enabled),
      });
      const bridge = makeBridge({
        channelFactory: async () => channel.channel,
      });
      try {
        expect(
          (await bridge.spawnOrAttach({ workspaceCwd: WS_A })).generatedUi,
        ).toBeUndefined();
        expect(
          channel.agent.extMethodCalls.filter(
            (call) => call.method === SERVE_STATUS_EXT_METHODS.sessionContext,
          ),
        ).toHaveLength(0);
      } finally {
        await bridge.shutdown();
      }
    },
  );
});
