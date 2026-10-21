import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

const input = {
  serverName: 'tableau',
  resourceUri: 'ui://app',
  name: 'get-embed-token',
  arguments: {},
};

describe('MCP App call ownership', () => {
  it('rejects foreign client ids and returns the raw result only to the caller', async () => {
    const raw = { content: [], _meta: { token: 'RAW_PRIVATE' } };
    const ext = vi.fn(async (method: string) =>
      method === 'qwen/session/mcp-app/call' ? raw : {},
    );
    const handle = makeChannel({ extMethodImpl: ext });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      await expect(
        bridge.callMcpAppTool(
          session.sessionId,
          input,
          new AbortController().signal,
          { clientId: 'foreign' },
        ),
      ).rejects.toThrow();
      expect(
        ext.mock.calls.filter(
          ([method]) => method === 'qwen/session/mcp-app/call',
        ),
      ).toHaveLength(0);
      await expect(
        bridge.callMcpAppTool(
          session.sessionId,
          input,
          new AbortController().signal,
          { clientId: session.clientId! },
        ),
      ).resolves.toEqual(raw);
    } finally {
      await bridge.shutdown();
    }
  });

  it('cancels only the App permission on abort and rejects late requests', async () => {
    let callId = '';
    let sessionId = '';
    let finish!: (value: Record<string, unknown>) => void;
    const handle = makeChannel({
      extMethodImpl: async (method, params) => {
        if (method === 'qwen/session/mcp-app/call') {
          callId = String(params['callId']);
          sessionId = String(params['sessionId']);
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        if (method === 'qwen/session/mcp-app/cancel') finish?.({ content: [] });
        return {};
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const controller = new AbortController();
      const pending = bridge.callMcpAppTool(
        session.sessionId,
        input,
        controller.signal,
        { clientId: session.clientId! },
      );
      await vi.waitFor(() => expect(callId).not.toBe(''));
      const request = () =>
        handle.agentConnection.requestPermission({
          sessionId,
          toolCall: { toolCallId: callId, title: 'App token' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          ],
          _meta: { mcpAppCallId: callId },
        });
      const permission = request();
      const modelPermission = handle.agentConnection.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'model-call', title: 'Model tool' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        ],
      });
      await vi.waitFor(() => expect(bridge.pendingPermissionCount).toBe(2));
      controller.abort();
      await expect(permission).resolves.toMatchObject({
        outcome: { outcome: 'cancelled' },
      });
      await pending;
      expect(bridge.pendingPermissionCount).toBe(1);
      await expect(request()).resolves.toMatchObject({
        outcome: { outcome: 'cancelled' },
      });
      const remaining =
        bridge.getSessionSummary(sessionId).pendingInteractions?.[0];
      expect(remaining).toBeDefined();
      expect(
        bridge.respondToPermission(
          remaining!.requestId,
          {
            outcome: { outcome: 'selected', optionId: 'allow' },
          },
          { clientId: session.clientId! },
        ),
      ).toBe(true);
      await expect(modelPermission).resolves.toMatchObject({
        outcome: { outcome: 'selected', optionId: 'allow' },
      });
    } finally {
      await bridge.shutdown();
    }
  });
});

const options = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' as const },
];

describe('App permission capacity', () => {
  it.each([64, 2, 1])(
    'reserves model capacity with total cap %i and recovers App capacity after abort',
    async (totalCap) => {
      let permissionsPerCall = totalCap;
      let cancelled = 0;
      const handle: ReturnType<typeof makeChannel> = makeChannel({
        extMethodImpl: async (method, params) => {
          if (method !== 'qwen/session/mcp-app/call') return {};
          const callId = String(params['callId']);
          const results: RequestPermissionResponse[] = await Promise.all(
            Array.from({ length: permissionsPerCall }, async (_, i) => {
              const result = await handle.agentConnection.requestPermission({
                sessionId: String(params['sessionId']),
                toolCall: { toolCallId: callId, title: `App permission ${i}` },
                options,
                _meta: { mcpAppCallId: callId },
              });
              if (result.outcome.outcome === 'cancelled') cancelled += 1;
              return result;
            }),
          );
          return {
            content: [],
            isError: results.some((r) => r.outcome.outcome === 'cancelled'),
          };
        },
      });
      const bridge = makeBridge({
        channelFactory: async () => handle.channel,
        ...(totalCap === 64
          ? {}
          : { maxPendingPermissionsPerSession: totalCap }),
      });
      const abort = new AbortController();
      let pending: Promise<unknown> | undefined;
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        pending = bridge.callMcpAppTool(
          session.sessionId,
          input,
          abort.signal,
          { clientId: session.clientId! },
        );
        await vi.waitFor(() =>
          expect(bridge.pendingPermissionCount + cancelled).toBe(totalCap),
        );

        let modelResolved = false;
        const model = handle.agentConnection
          .requestPermission({
            sessionId: session.sessionId,
            toolCall: {
              toolCallId: 'model-call',
              title: 'Primary model permission',
            },
            options,
          })
          .then((value) => {
            modelResolved = true;
            return value;
          });
        const findModel = () =>
          bridge
            .getSessionSummary(session.sessionId)
            .pendingInteractions?.find(
              (p) =>
                p.kind === 'permission' &&
                p.action?.title === 'Primary model permission',
            );
        await vi.waitFor(() =>
          expect(modelResolved || !!findModel()).toBe(true),
        );
        const modelRequest = findModel();
        if (modelRequest)
          expect(
            bridge.respondToPermission(
              modelRequest.requestId,
              { outcome: { outcome: 'selected', optionId: 'allow' } },
              { clientId: session.clientId! },
            ),
          ).toBe(true);
        await expect(model).resolves.toMatchObject({
          outcome: { outcome: 'selected', optionId: 'allow' },
        });
        expect(bridge.pendingPermissionCount).toBe(Math.min(8, totalCap - 1));
        expect(bridge.pendingPermissionCount).toBeLessThan(totalCap);

        abort.abort();
        await pending;
        await vi.waitFor(() => expect(bridge.pendingPermissionCount).toBe(0));
        permissionsPerCall = 1;
        const next = bridge.callMcpAppTool(
          session.sessionId,
          input,
          new AbortController().signal,
          { clientId: session.clientId! },
        );
        if (totalCap > 1) {
          await vi.waitFor(() => expect(bridge.pendingPermissionCount).toBe(1));
          const request = bridge.getSessionSummary(session.sessionId)
            .pendingInteractions![0];
          expect(
            bridge.respondToPermission(
              request.requestId,
              { outcome: { outcome: 'selected', optionId: 'allow' } },
              { clientId: session.clientId! },
            ),
          ).toBe(true);
          await expect(next).resolves.toMatchObject({ isError: false });
        } else {
          await expect(next).resolves.toMatchObject({ isError: true });
        }
        expect(bridge.pendingPermissionCount).toBe(0);
      } finally {
        abort.abort();
        await pending?.catch(() => undefined);
        await bridge.shutdown();
      }
    },
  );
});
