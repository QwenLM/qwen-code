/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HookEventName,
  HooksConfigSource,
  HookType,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import { HttpHookRunner } from '@qwen-code/qwen-code-core/hooks/httpHookRunner.js';
import { ManagedOperationGrantGate } from '@qwen-code/qwen-code-core/managed-runtime/managed-operation-grant-gate.js';
import type {
  ManagedHookExecute,
  ManagedHookOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import {
  ManagedHookRuntime,
  parseManagedHookControl,
  type ManagedHookDefinition,
} from './managed-hook-runtime.js';
const key = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: 'session',
};
const hasCgroup =
  process.platform === 'linux' &&
  Boolean(process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT']);
const pin = {
  catalogId: 'hooks',
  catalogRevision: 1,
  definitionDigest: 'a'.repeat(64),
};
let directory: string;
let runtimes: ManagedHookRuntime[];
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'managed-hooks-'));
  runtimes = [];
});
afterEach(async () => {
  await Promise.all(runtimes.map((r) => r.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function definition(): ManagedHookDefinition {
  return {
    hookId: 'one',
    eventName: HookEventName.PreToolUse,
    sequential: false,
    onceKey: null,
    failClosed: true,
    async: false,
    config: {
      type: HookType.Command,
      command: 'printf x >> counter',
      timeout: 5000,
    },
  };
}
function runtime(hooks = [definition()], active = true) {
  const result = new ManagedHookRuntime(
    { ...key, workspaceGeneration: '1' },
    async (id) => (active && id === 'runtime-session' ? directory : undefined),
    {
      version: 1,
      catalogs: [
        { ...pin, tenantId: key.tenantId, workspaceId: key.workspaceId, hooks },
      ],
    },
  );
  runtimes.push(result);
  return result;
}
function request(id = 'execution'): ManagedHookExecute {
  return {
    kind: 'hook-execute',
    pin,
    sessionKey: key,
    operationId: id,
    hookId: 'one',
    input: {
      session_id: key.sessionId,
      cwd: '/not-the-workspace',
      transcript_path: '',
      hook_event_name: HookEventName.PreToolUse,
      timestamp: new Date().toISOString(),
    },
    grant: {
      sessionKey: key,
      operationId: id,
      domain: 'hook_execution',
      operationRevision: 1,
      ownerId: 'harness',
      workspaceGeneration: '1',
      resourceScope: {
        recordRef: {
          resourceId: 'record',
          kind: 'managed-hook_execution',
          schemaVersion: 1,
          byteLength: 1,
          digest: 'b'.repeat(64),
        },
        phases: ['execute'],
      },
      leaseDurationMs: 300_000,
      expiresAt: Date.now() + 300_000,
    },
  };
}
async function settled(instance: ManagedHookRuntime, id = 'execution') {
  let view: ManagedHookOperationView;
  await vi.waitFor(
    async () => {
      view = await instance.control('runtime-session', {
        kind: 'hook-status',
        sessionKey: key,
        operationId: 'lookup',
        targetOperationId: id,
      });
      expect(view.state).not.toBe('running');
    },
    { timeout: 8000 },
  );
  return view!;
}
describe('ManagedHookRuntime', () => {
  it.each([1, 2])(
    'fences native hook dispatch when CSI seals during directory lookup %s',
    async (gateLookup) => {
      let lookups = 0;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      const lookup = new Promise<void>((resolve) => (release = resolve));
      const instance = new ManagedHookRuntime(
        { ...key, workspaceGeneration: '1' },
        async () => {
          if (++lookups === gateLookup) {
            entered();
            await lookup;
          }
          return directory;
        },
        {
          version: 1,
          catalogs: [
            {
              ...pin,
              tenantId: key.tenantId,
              workspaceId: key.workspaceId,
              hooks: [
                {
                  ...definition(),
                  config: {
                    type: HookType.Http,
                    url: 'https://example.com/hook',
                  },
                },
              ],
            },
          ],
        },
      );
      runtimes.push(instance);
      const native = vi.spyOn(HttpHookRunner.prototype, 'execute');
      const call = request();
      const pending = instance.control('runtime-session', call);
      const result = pending.catch((error: unknown) => error);
      await waiting;
      expect(instance.getDrainInspection()).toMatchObject({
        hasActivity: true,
        ...(gateLookup === 1
          ? { pendingStarts: 1 }
          : { pendingInvocations: 1 }),
      });
      instance.sealAdmission();
      try {
        await expect(
          instance.control('runtime-session', request('new')),
        ).rejects.toThrow('managed_hook_closed');
        if (gateLookup === 2) {
          expect(await instance.control('runtime-session', call)).toMatchObject(
            {
              operationId: call.operationId,
              state: 'running',
            },
          );
          await expect(
            instance.control('runtime-session', {
              ...call,
              input: { ...call.input, timestamp: 'different' },
            }),
          ).rejects.toThrow('managed_hook_operation_conflict');
          expect(
            await instance.control('runtime-session', {
              kind: 'hook-status',
              sessionKey: key,
              operationId: 'status',
              targetOperationId: call.operationId,
            }),
          ).toMatchObject({ state: 'running' });
        }
      } finally {
        release();
      }
      if (gateLookup === 1) {
        expect(await result).toMatchObject({ code: 'managed_hook_closed' });
      } else {
        await result;
        const receipt = await settled(instance);
        expect(receipt).toMatchObject({
          state: 'settled',
          error: { code: 'managed_hook_closed' },
        });
        expect(await instance.control('runtime-session', call)).toEqual(
          receipt,
        );
        expect(
          await instance.control('runtime-session', {
            kind: 'hook-cancel',
            sessionKey: key,
            operationId: 'cancel',
            targetOperationId: call.operationId,
          }),
        ).toEqual(receipt);
      }
      expect(native).not.toHaveBeenCalled();
      await instance.close();
      expect(instance.getDrainInspection()).toEqual({
        hasActivity: true,
        pendingStarts: 0,
        pendingInvocations: 0,
      });
    },
  );

  it.each(['_scope', '.scope', '-scope', ':scope'])(
    'accepts existing scope and manifest identifiers with a leading punctuation (%s)',
    async (id) => {
      const scopedKey = { tenantId: id, workspaceId: id, sessionId: id };
      const scopedPin = { ...pin, catalogId: id };
      const instance = new ManagedHookRuntime(
        { ...scopedKey, workspaceGeneration: '1' },
        async () => directory,
        {
          version: 1,
          catalogs: [
            {
              ...scopedPin,
              tenantId: id,
              workspaceId: id,
              hooks: [{ ...definition(), hookId: id }],
            },
          ],
        },
      );
      runtimes.push(instance);
      const original = request(id);
      const call = {
        ...original,
        sessionKey: scopedKey,
        pin: scopedPin,
        hookId: id,
        input: { ...original.input, session_id: id },
        grant: { ...original.grant, sessionKey: scopedKey, ownerId: id },
      };
      expect(() => parseManagedHookControl(call)).not.toThrow();
      for (const kind of ['hook-status', 'hook-cancel'] as const)
        expect(() =>
          parseManagedHookControl({
            kind,
            sessionKey: scopedKey,
            operationId: id,
            targetOperationId: id,
          }),
        ).not.toThrow();
      const view = await instance.control('runtime-session', {
        kind: 'hook-catalog',
        sessionKey: scopedKey,
        operationId: id,
        pin: scopedPin,
      });
      expect(view).toMatchObject({
        state: 'settled',
        catalog: { catalogId: id, hooks: [{ hookId: id }] },
      });
    },
  );

  it.each(['', 'a/b', 'a b', 'a'.repeat(513)])(
    'still rejects invalid Hook identifiers (%s)',
    (id) => {
      expect(() =>
        parseManagedHookControl({ ...request(), operationId: id }),
      ).toThrow('managed_hook_invalid');
      expect(() => runtime([{ ...definition(), hookId: id }])).toThrow(
        'managed_hook_manifest_invalid',
      );
    },
  );

  it.each([
    {
      name: 'allowed',
      variable: 'HOOK_TENANT',
      value: 'acme',
      allowed: true,
      path: '/hooks/acme',
    },
    {
      name: 'unlisted',
      variable: 'HOOK_TENANT',
      value: 'acme',
      allowed: false,
      path: '/hooks/',
    },
    {
      name: 'internal secret',
      variable: 'QWEN_SERVER_TOKEN',
      value: 'secret',
      allowed: true,
      path: '/hooks/',
    },
    {
      name: 'one interpolation',
      variable: 'HOOK_TENANT',
      value: '${HOOK_OTHER}',
      allowed: true,
      path: '/hooks/$%7BHOOK_OTHER%7D',
    },
  ])(
    'dispatches the native interpolated URL ($name)',
    async ({ variable, value, allowed, path: expectedPath }) => {
      vi.stubEnv(variable, value);
      vi.stubEnv('HOOK_OTHER', 'recursive');
      const paths: string[] = [];
      const server = createServer((req, res) => {
        paths.push(req.url!);
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"continue":true}');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: HookType.Http,
            url: `http://127.0.0.1:${address.port}/hooks/\${${variable}}`,
            allowedEnvVars: allowed ? [variable, 'HOOK_OTHER'] : [],
          },
        },
      ]);
      try {
        const call = request();
        await instance.control('runtime-session', call);
        expect(await settled(instance)).toMatchObject({
          state: 'settled',
          result: { success: true, outcome: 'success' },
        });
        expect(await instance.control('runtime-session', call)).toMatchObject({
          state: 'settled',
        });
        expect(paths).toEqual([expectedPath]);
        expect(instance.hasHolds('runtime-session')).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(['10.0.0.1', '169.254.169.254', '100.100.100.200'])(
    'retains native SSRF refusal after interpolating host %s',
    async (host) => {
      vi.stubEnv('HOOK_HOST', host);
      const fetch = vi.spyOn(globalThis, 'fetch');
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: HookType.Http,
            url: 'http://${HOOK_HOST}/hook',
            allowedEnvVars: ['HOOK_HOST'],
          },
        },
      ]);
      await instance.control('runtime-session', request());
      expect(await settled(instance)).toMatchObject({
        state: 'settled',
        result: { success: false, outcome: 'non_blocking_error' },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(instance.hasHolds('runtime-session')).toBe(false);
    },
  );

  it.each([HookEventName.PreToolUse, HookEventName.PermissionRequest])(
    'retains quota refusals without dispatch or eviction and bounds grant storage (%s)',
    async (eventName) => {
      const hookRequest = (id: string) => {
        const operation = request(id);
        operation.input.hook_event_name = eventName;
        return operation;
      };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => (release = resolve));
      const execute = vi
        .spyOn(HttpHookRunner.prototype, 'execute')
        .mockImplementation(async () => {
          await pending;
          return {
            hookConfig: {
              type: HookType.Http,
              url: 'https://example.com/hook',
            },
            eventName,
            success: true,
            outcome: 'success',
            httpRequestState: 'response_received',
            duration: 1,
          };
        });
      const install = vi.spyOn(ManagedOperationGrantGate.prototype, 'install');
      const instance = runtime([
        {
          ...definition(),
          eventName,
          failClosed: false,
          config: { type: HookType.Http, url: 'https://example.com/hook' },
        },
      ]);
      const calls = Array.from({ length: 17 }, (_, index) =>
        hookRequest(`call-${index}`),
      );
      try {
        const admitted = await Promise.all(
          calls.map((call) => instance.control('runtime-session', call)),
        );
        expect(
          admitted.slice(0, 16).every((view) => view.state === 'running'),
        ).toBe(true);
        const refused = admitted[16];
        expect(refused).toMatchObject({
          state: 'settled',
          result: { success: false, outcome: 'non_blocking_error' },
        });
        expect(await settled(instance, calls[16].operationId)).toEqual(refused);
        expect(execute).toHaveBeenCalledTimes(16);
        for (let index = 17; index < 4096; index++)
          expect(
            (
              await instance.control(
                'runtime-session',
                hookRequest(`call-${index}`),
              )
            ).result?.success,
          ).toBe(false);
        expect(install).toHaveBeenCalledTimes(4096);
        release();
        const original = await settled(instance, calls[0].operationId);
        expect(original.result?.success).toBe(true);
        expect(await instance.control('runtime-session', calls[0])).toEqual(
          original,
        );
        expect(await instance.control('runtime-session', calls[16])).toEqual(
          refused,
        );
        for (let index = 4096; index < 4100; index++)
          expect(
            await instance.control(
              'runtime-session',
              hookRequest(`call-${index}`),
            ),
          ).toMatchObject({
            state: 'settled',
            result: {
              success: false,
              outcome: 'blocking',
              output: {
                continue: false,
                decision: 'block',
                ...(eventName === HookEventName.PermissionRequest
                  ? {
                      hookSpecificOutput: {
                        decision: { behavior: 'deny', interrupt: true },
                      },
                    }
                  : {}),
              },
            },
          });
        expect(install).toHaveBeenCalledTimes(4096);
        expect(execute).toHaveBeenCalledTimes(16);
        expect(instance.hasHolds('runtime-session')).toBe(false);
        expect((await settled(instance, 'call-4096')).state).toBe(
          'outcome_unknown',
        );
      } finally {
        release();
      }
    },
  );

  it.each([
    [HookType.Command, 'cancel'],
    [HookType.Http, 'cancel'],
    [HookType.Command, 'expire'],
    [HookType.Http, 'expire'],
  ] as const)(
    'settles %s after %s during final owner lookup without dispatch',
    async (type, action) => {
      let lookups = 0;
      let release!: () => void;
      const lookup = new Promise<void>((resolve) => (release = resolve));
      const hook: ManagedHookDefinition = {
        ...definition(),
        ...(type === HookType.Http
          ? { config: { type, url: 'https://example.com/hook' } }
          : {}),
      };
      const instance = new ManagedHookRuntime(
        { ...key, workspaceGeneration: '1' },
        async () => {
          if (++lookups === 2) await lookup;
          return directory;
        },
        {
          version: 1,
          catalogs: [
            {
              ...pin,
              tenantId: key.tenantId,
              workspaceId: key.workspaceId,
              hooks: [hook],
            },
          ],
        },
      );
      runtimes.push(instance);
      const http = vi.spyOn(HttpHookRunner.prototype, 'execute');
      const call = request();
      await instance.control('runtime-session', call);
      expect(lookups).toBe(2);
      if (action === 'cancel')
        await instance.control('runtime-session', {
          kind: 'hook-cancel',
          sessionKey: key,
          operationId: 'cancel',
          targetOperationId: 'execution',
        });
      else vi.spyOn(Date, 'now').mockReturnValue(call.grant.expiresAt + 1);
      release();
      expect(await settled(instance)).toMatchObject({
        state: 'settled',
        result: {
          outcome: action === 'cancel' ? 'cancelled' : 'non_blocking_error',
        },
      });
      expect(instance.hasHolds('runtime-session')).toBe(false);
      expect(http).not.toHaveBeenCalled();
      await expect(readFile(path.join(directory, 'counter'))).rejects.toThrow();
    },
  );

  it.skipIf(!hasCgroup)(
    'executes once in the resolved directory and replays the original receipt',
    async () => {
      const instance = runtime();
      const call = request();
      await Promise.all([
        instance.control('runtime-session', call),
        instance.control('runtime-session', call),
      ]);
      const result = await settled(instance);
      expect(result).toMatchObject({
        state: 'settled',
        result: { success: true, outcome: 'success' },
      });
      expect(await instance.control('runtime-session', call)).toEqual(result);
      expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe('x');
      expect(instance.hasHolds('runtime-session')).toBe(false);
      await expect(
        instance.control('runtime-session', {
          ...call,
          input: { ...call.input, timestamp: 'changed' },
        }),
      ).rejects.toThrow('operation_conflict');
    },
  );
  it.skipIf(!hasCgroup)(
    'keeps async ownership until descendants finish after their shell exits',
    async () => {
      const instance = runtime([
        {
          ...definition(),
          async: true,
          config: {
            type: HookType.Command,
            command: '(sleep 0.2; printf x >> counter) >/dev/null 2>&1 &',
            timeout: 5000,
          },
        },
      ]);
      expect((await instance.control('runtime-session', request())).state).toBe(
        'running',
      );
      expect(instance.hasHolds('runtime-session')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(instance.hasHolds('runtime-session')).toBe(true);
      expect((await settled(instance)).state).toBe('settled');
      expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe('x');
    },
  );
  it('retains a not-started receipt when command isolation is unavailable', async () => {
    vi.stubEnv('QWEN_MANAGED_HOOK_CGROUP_ROOT', '');
    const instance = runtime();
    const call = request();
    await instance.control('runtime-session', call);
    const receipt = await settled(instance);
    expect(receipt).toEqual({
      operationId: call.operationId,
      state: 'settled',
      error: { code: 'managed_hook_command_isolation_unavailable' },
    });
    expect(await instance.control('runtime-session', call)).toEqual(receipt);
    expect(
      await instance.control('runtime-session', {
        kind: 'hook-cancel',
        sessionKey: key,
        operationId: 'cancel',
        targetOperationId: call.operationId,
      }),
    ).toEqual(receipt);
    expect(instance.hasHolds('runtime-session')).toBe(false);
    await expect(readFile(path.join(directory, 'counter'))).rejects.toThrow();
  });
  it('hides deployment recipes from catalogs', async () => {
    const instance = runtime([
      {
        ...definition(),
        config: {
          type: HookType.Command,
          name: 'display',
          command: 'private-command',
          env: { SECRET: 'private-secret' },
        },
      },
    ]);
    const view = await instance.control('runtime-session', {
      kind: 'hook-catalog',
      pin,
      operationId: 'catalog',
      sessionKey: key,
    });
    expect(view.catalog?.hooks[0].config).toEqual({
      type: 'command',
      name: 'display',
    });
    expect(JSON.stringify(view)).not.toContain('private-');
  });
  it('rejects inactive, cross-workspace, cross-session, expired and wrongly scoped calls', async () => {
    const instance = runtime();
    const call = request();
    await expect(
      runtime(undefined, false).control('runtime-session', call),
    ).rejects.toThrow('session_unavailable');
    await expect(instance.control('other-runtime', call)).rejects.toThrow(
      'session_unavailable',
    );
    await expect(
      instance.control('runtime-session', {
        ...call,
        sessionKey: { ...key, workspaceId: 'other' },
      }),
    ).rejects.toThrow('scope_conflict');
    await expect(
      instance.control('runtime-session', {
        ...call,
        input: { ...call.input, session_id: 'other' },
      }),
    ).rejects.toThrow('managed_hook_invalid');
    for (const grant of [
      { ...call.grant, domain: 'mcp_operation' },
      { ...call.grant, operationId: 'other' },
      { ...call.grant, workspaceGeneration: 'old' },
      { ...call.grant, expiresAt: Date.now() - 1 },
      {
        ...call.grant,
        resourceScope: { ...call.grant.resourceScope, phases: ['discover'] },
      },
    ])
      await expect(
        instance.control('runtime-session', { ...call, grant }),
      ).rejects.toThrow('grant_invalid');
    await expect(readFile(path.join(directory, 'counter'))).rejects.toThrow();
  });
  it('retains unknown HTTP sends and never resends the same effect', async () => {
    const execute = vi
      .spyOn(HttpHookRunner.prototype, 'execute')
      .mockResolvedValue({
        hookConfig: { type: HookType.Http, url: 'https://example.com/hook' },
        eventName: HookEventName.PreToolUse,
        success: true,
        outcome: 'non_blocking_error',
        duration: 1,
        output: { continue: true },
      });
    const instance = runtime([
      {
        ...definition(),
        config: { type: HookType.Http, url: 'https://example.com/hook' },
      },
    ]);
    const call = request();
    await instance.control('runtime-session', call);
    expect((await settled(instance)).state).toBe('outcome_unknown');
    await instance.control('runtime-session', call);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(instance.hasHolds('runtime-session')).toBe(true);
  });
  it('settles received HTTP failures so the logical fail policy can decide', async () => {
    vi.spyOn(HttpHookRunner.prototype, 'execute').mockResolvedValue({
      hookConfig: { type: HookType.Http, url: 'https://example.com/hook' },
      eventName: HookEventName.PreToolUse,
      success: true,
      outcome: 'non_blocking_error',
      httpRequestState: 'response_received',
      duration: 1,
      output: { continue: true },
    });
    const instance = runtime([
      {
        ...definition(),
        config: { type: HookType.Http, url: 'https://example.com/hook' },
      },
    ]);
    await instance.control('runtime-session', request());
    expect(await settled(instance)).toMatchObject({
      state: 'settled',
      result: { outcome: 'non_blocking_error' },
    });
    expect(instance.hasHolds('runtime-session')).toBe(false);
  });

  it.each(['response', 'timeout', 'lost-reply', 'shutdown'])(
    'waits for HTTP completion evidence after cancel (%s)',
    async (completion) => {
      let response!: ServerResponse;
      let calls = 0;
      let started!: () => void;
      const dispatched = new Promise<void>((resolve) => (started = resolve));
      const server = createServer((req, res) => {
        req.resume();
        response = res;
        calls++;
        started();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: HookType.Http,
            url: `http://127.0.0.1:${address.port}/hook`,
            timeout: completion === 'timeout' ? 1 : 60,
          },
        },
      ]);
      const call = request();
      try {
        await instance.control('runtime-session', call);
        await dispatched;
        expect(
          await instance.control('runtime-session', {
            kind: 'hook-cancel',
            sessionKey: key,
            operationId: 'cancel',
            targetOperationId: call.operationId,
          }),
        ).toMatchObject({ state: 'running' });
        expect(instance.hasHolds('runtime-session')).toBe(true);
        if (completion === 'response') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"continue":false}');
        } else if (completion === 'lost-reply') response.destroy();
        else if (completion === 'shutdown') await instance.close();
        const receipt = await settled(instance);
        if (completion === 'response')
          expect(receipt).toMatchObject({
            state: 'settled',
            result: { outcome: 'success', output: { continue: false } },
          });
        else expect(receipt.state).toBe('outcome_unknown');
        expect(instance.hasHolds('runtime-session')).toBe(
          completion !== 'response',
        );
        expect(await instance.control('runtime-session', call)).toEqual(
          receipt,
        );
        expect(calls).toBe(1);
      } finally {
        await instance.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('settles an HTTP runner construction failure without dispatch or replay', async () => {
    const execute = vi.spyOn(HttpHookRunner.prototype, 'execute');
    const instance = runtime([
      {
        ...definition(),
        config: {
          type: HookType.Http,
          url: String.raw`https://example.com/\.[`,
        },
      },
    ]);
    const call = request();
    await instance.control('runtime-session', call);
    const receipt = await settled(instance);
    expect(receipt).toMatchObject({
      state: 'settled',
      result: { success: false, outcome: 'non_blocking_error' },
    });
    expect(await instance.control('runtime-session', call)).toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
    expect(instance.hasHolds('runtime-session')).toBe(false);
  });

  it.skipIf(!hasCgroup)(
    'settles cancellation only after the execution cgroup has drained',
    async () => {
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: HookType.Command,
            command: 'printf start > started; sleep 30',
            timeout: 60_000,
          },
        },
      ]);
      await instance.control('runtime-session', request());
      await vi.waitFor(async () =>
        expect(await readFile(path.join(directory, 'started'), 'utf8')).toBe(
          'start',
        ),
      );
      await instance.control('runtime-session', {
        kind: 'hook-cancel',
        operationId: 'cancel',
        sessionKey: key,
        targetOperationId: 'execution',
      });
      expect(await settled(instance)).toMatchObject({
        state: 'settled',
        result: { outcome: 'cancelled' },
      });
      expect(instance.hasHolds('runtime-session')).toBe(false);
    },
  );
  it('reconstructs trusted handlers and reports missing exports without dispatch', async () => {
    const modulePath = path.join(directory, 'handler.mjs');
    await writeFile(
      modulePath,
      'export const registered = { handlerRevision: 2, callback: async input => ({continue: true, systemMessage: input.cwd}) };',
    );
    const hook: ManagedHookDefinition = {
      ...definition(),
      config: { type: 'function', timeout: 1000 },
      handler: {
        handlerId: 'registered',
        handlerRevision: 2,
        modulePath,
        exportName: 'registered',
      },
    };
    const instance = runtime([hook]);
    await instance.control('runtime-session', request());
    expect(await settled(instance)).toMatchObject({
      state: 'settled',
      result: { output: { systemMessage: directory } },
    });
    const missing = runtime([
      { ...hook, handler: { ...hook.handler!, exportName: 'missing' } },
    ]);
    await missing.control('runtime-session', request());
    expect(await settled(missing)).toMatchObject({
      state: 'settled',
      error: { code: 'managed_hook_handler_unavailable' },
    });
  });
  it.each([
    'resolve-on-abort',
    'reject-on-abort',
    'ignore-abort',
    'finish-after-timeout',
  ])(
    'keeps function interruption proof tied to callback completion (%s)',
    async (behavior) => {
      const modulePath = path.join(directory, 'cancel-handler.mjs');
      await writeFile(
        modulePath,
        `
        import { appendFileSync } from 'node:fs';
        import { setTimeout as delay } from 'node:timers/promises';
        let finish;
        export const release = () => finish();
        export const registered = { handlerRevision: 1, callback: async (input, context) => {
          appendFileSync(input.cwd + '/counter', 'started\\n');
          try {
            await new Promise((resolve, reject) => {
              finish = resolve;
              if (${JSON.stringify(behavior)} === 'finish-after-timeout') setTimeout(resolve, 50);
              else if (${JSON.stringify(behavior)} !== 'ignore-abort') {
                const stop = () => ${JSON.stringify(behavior)} === 'reject-on-abort'
                  ? reject(new DOMException('cancelled', 'AbortError')) : resolve();
                context.signal.addEventListener('abort', stop, { once: true });
                if (context.signal.aborted) stop();
              }
            });
            return { continue: true };
          } finally {
            await delay(10);
            appendFileSync(input.cwd + '/counter', 'settled\\n');
          }
        }};
      `,
      );
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: 'function',
            timeout: behavior === 'finish-after-timeout' ? 10 : 8000,
          },
          handler: {
            handlerId: 'cancel-handler',
            handlerRevision: 1,
            modulePath,
            exportName: 'registered',
          },
        },
      ]);
      const call = request();
      await instance.control('runtime-session', call);
      await vi.waitFor(async () => {
        const trace = await readFile(path.join(directory, 'counter'), 'utf8');
        if (behavior === 'finish-after-timeout')
          expect(trace).toContain('started\n');
        else expect(trace).toBe('started\n');
      });
      if (behavior !== 'finish-after-timeout')
        await instance.control('runtime-session', {
          kind: 'hook-cancel',
          sessionKey: key,
          operationId: 'cancel',
          targetOperationId: call.operationId,
        });
      const receipt = await settled(instance);
      if (behavior === 'ignore-abort') {
        expect(receipt.state).toBe('outcome_unknown');
        expect(instance.hasHolds('runtime-session')).toBe(true);
        expect(await instance.control('runtime-session', call)).toEqual(
          receipt,
        );
        expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe(
          'started\n',
        );
        const module = (await import(modulePath)) as { release: () => void };
        module.release();
        await vi.waitFor(async () => {
          expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe(
            'started\nsettled\n',
          );
        });
      } else {
        expect(receipt).toMatchObject({
          state: 'settled',
          result: {
            success: false,
            outcome:
              behavior === 'finish-after-timeout' ? 'timeout' : 'cancelled',
          },
        });
        expect(instance.hasHolds('runtime-session')).toBe(false);
        expect(await instance.control('runtime-session', call)).toEqual(
          receipt,
        );
        expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe(
          'started\nsettled\n',
        );
      }
    },
  );

  it('keeps oversized output as a bounded failure receipt without replay', async () => {
    const modulePath = path.join(directory, 'large-handler.mjs');
    await writeFile(
      modulePath,
      `import { appendFileSync } from 'node:fs';
       export const registered = { handlerRevision: 1, callback: async input => {
         appendFileSync(input.cwd + '/counter', 'x');
         return { systemMessage: 'x'.repeat(70 * 1024) };
       } };`,
    );
    const instance = runtime([
      {
        ...definition(),
        config: { type: 'function', timeout: 1000 },
        handler: {
          handlerId: 'registered',
          handlerRevision: 1,
          modulePath,
          exportName: 'registered',
        },
      },
    ]);
    const call = request();
    await instance.control('runtime-session', call);
    const receipt = await settled(instance);
    expect(receipt).toMatchObject({
      state: 'settled',
      result: { success: false, outcome: 'non_blocking_error' },
    });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1024);
    expect(await instance.control('runtime-session', call)).toEqual(receipt);
    expect(await readFile(path.join(directory, 'counter'), 'utf8')).toBe('x');
    expect(instance.hasHolds('runtime-session')).toBe(false);
  });
  it('uses native source ordering and identity while keeping session hooks independent', async () => {
    const base = definition();
    const instance = runtime([
      { ...base, hookId: 'system', source: HooksConfigSource.System },
      { ...base, hookId: 'user', source: HooksConfigSource.User },
      { ...base, hookId: 'project', source: HooksConfigSource.Project },
      {
        ...base,
        hookId: 'untrusted',
        source: HooksConfigSource.Project,
        sourceTrusted: false,
      },
      { ...base, hookId: 'duplicate', source: HooksConfigSource.Project },
      {
        ...base,
        hookId: 'session',
        source: HooksConfigSource.Session,
        owner: { sessionId: key.sessionId, agentId: null },
      },
    ]);
    const view = await instance.control('runtime-session', {
      kind: 'hook-catalog',
      pin,
      sessionKey: key,
      operationId: 'catalog',
    });
    expect(view.catalog!.hooks.map((hook) => hook.hookId)).toEqual([
      'project',
      'user',
      'system',
      'session',
    ]);
    expect(
      new Set(view.catalog!.hooks.slice(0, 3).map((hook) => hook.plannerKey))
        .size,
    ).toBe(1);
    expect(view.catalog!.hooks.at(-1)!.plannerKey).toBeUndefined();
  });

  it.skipIf(!hasCgroup)(
    'passes only the Session environment view and explicitly scoped variables to commands',
    async () => {
      vi.stubEnv('MANAGED_HOOK_AMBIENT_SECRET', 'ambient-secret');
      const instance = runtime([
        {
          ...definition(),
          config: {
            type: HookType.Command,
            command:
              'printf "%s|%s|%s" "$HOME" "$SCOPED" "$MANAGED_HOOK_AMBIENT_SECRET"',
            env: { SCOPED: 'allowed' },
          },
        },
      ]);
      await instance.control('runtime-session', request());
      expect((await settled(instance)).result?.stdout).toBe(
        `${directory}|allowed|`,
      );
      vi.unstubAllEnvs();
    },
  );

  it('restores handler context and runs the deployment success callback once', async () => {
    const modulePath = path.join(directory, 'context-handler.mjs');
    const counter = path.join(directory, 'success-counter');
    await writeFile(
      modulePath,
      `import {appendFileSync} from 'node:fs'; export const registered = {
      handlerRevision:1,
      callback: async (_input, context) => ({systemMessage:JSON.stringify({messages:context.messages,id:context.toolUseID})}),
      onHookSuccess: () => appendFileSync(${JSON.stringify(counter)}, 'x'),
    };`,
    );
    const instance = runtime([
      {
        ...definition(),
        config: { type: 'function', timeout: 1000 },
        handler: {
          handlerId: 'context',
          handlerRevision: 1,
          modulePath,
          exportName: 'registered',
        },
      },
    ]);
    const original = request();
    const call = {
      ...original,
      input: {
        ...original.input,
        messages: [{ role: 'user', content: 'hello' }],
        tool_use_id: 'tool',
      },
    };
    await instance.control('runtime-session', call);
    const result = await settled(instance);
    expect(JSON.parse(result.result!.output!.systemMessage!)).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      id: 'tool',
    });
    await instance.control('runtime-session', call);
    expect(await readFile(counter, 'utf8')).toBe('x');
  });

  it('refuses worker model calls and never executes on a cold lookup', async () => {
    const instance = runtime([
      {
        ...definition(),
        config: { type: HookType.Prompt, prompt: 'Should this continue?' },
      },
    ]);
    await expect(
      instance.control('runtime-session', request()),
    ).rejects.toThrow('requires_harness');
    expect(
      await instance.control('runtime-session', {
        kind: 'hook-status',
        sessionKey: key,
        operationId: 'lookup',
        targetOperationId: 'execution',
      }),
    ).toEqual({ operationId: 'execution', state: 'outcome_unknown' });
  });
});
