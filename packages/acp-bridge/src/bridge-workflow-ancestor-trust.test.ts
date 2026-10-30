/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '@agentclientprotocol/sdk';
import { BridgeClient, type BridgeClientSessionEntry } from './bridgeClient.js';
import { makeBridge, makeChannel } from './internal/testUtils.js';
import { SERVE_CONTROL_EXT_METHODS } from './status.js';
import {
  WORKFLOW_ANCESTOR_TRUST_METHOD,
  type WorkflowAncestorTrustDecision,
  type WorkflowAncestorTrustHandler,
} from './workflow-ancestor-trust.js';

function decision(trusted: readonly boolean[]): WorkflowAncestorTrustDecision {
  return { trusted, isCurrent: () => true };
}

describe('workflow ancestor trust bridge dispatch', () => {
  let directory: string;
  let entry: BridgeClientSessionEntry | undefined;
  let owned: boolean;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-workflow-trust-')),
    );
    entry = {
      sessionId: 'session',
      workspaceCwd: directory,
      effectiveCwd: directory,
      closing: false,
    } as BridgeClientSessionEntry;
    owned = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  function request() {
    return {
      v: 1,
      sessionId: 'session',
      canonicalTargetDir: directory,
      ancestorDirs: [path.dirname(directory)],
    };
  }

  function makeClient(handler?: WorkflowAncestorTrustHandler) {
    const resolveEntry = vi.fn((id?: string) =>
      id === 'session' ? entry : undefined,
    );
    const args: ConstructorParameters<typeof BridgeClient> = [
      resolveEntry,
      () => undefined,
      {
        request: async () => {
          throw new Error('Unexpected permission request');
        },
        cancelForPrompt: () => undefined,
      },
      0,
      Infinity,
    ];
    args[9] = () => owned;
    args[26] = handler;
    return { client: new BridgeClient(...args), resolveEntry };
  }

  it('keeps the method unavailable without a host hook', async () => {
    const { client } = makeClient();
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
    ).rejects.toMatchObject({ code: -32601 });
  });

  it('rejects shape errors before resolving any session', async () => {
    const handler = vi.fn(async () => decision([true]));
    const { client, resolveEntry } = makeClient(handler);
    for (const invalid of [
      { ...request(), sessionId: undefined },
      { ...request(), v: 0 },
      { ...request(), ancestorDirs: new Array(1) },
    ]) {
      await expect(
        client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, invalid),
      ).rejects.toMatchObject({ code: -32602 });
    }
    expect(resolveEntry).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes parent-owned cwd values and preserves the whole decision batch', async () => {
    const handler = vi.fn(async () => decision([true, false]));
    const { client } = makeClient(handler);
    const params = {
      ...request(),
      ancestorDirs: [path.dirname(directory), path.parse(directory).root],
      workspaceCwd: '/untrusted-client-workspace',
    };
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, params),
    ).resolves.toEqual({ v: 1, trusted: [true, false] });
    expect(handler).toHaveBeenCalledWith({
      sessionId: 'session',
      workspaceCwd: directory,
      effectiveCwd: directory,
      canonicalTargetDir: directory,
      ancestorDirs: params.ancestorDirs,
    });
  });

  it.each(['foreign', 'missing', 'closing', 'fenced', 'cwd-mismatch'])(
    'denies an unavailable %s context without calling the host',
    async (state) => {
      const handler = vi.fn(async () => decision([true]));
      const { client, resolveEntry } = makeClient(handler);
      const params = request();
      if (state === 'foreign') owned = false;
      if (state === 'missing') entry = undefined;
      if (state === 'closing') entry!.closing = true;
      if (state === 'fenced') entry!.workspaceChangeFence = 1;
      if (state === 'cwd-mismatch')
        params.canonicalTargetDir = path.dirname(directory);
      await expect(
        client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, params),
      ).resolves.toEqual({ v: 1, trusted: [false] });
      if (state === 'foreign') expect(resolveEntry).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('returns an empty batch without a session lookup', async () => {
    const handler = vi.fn(async () => decision([true]));
    const { client, resolveEntry } = makeClient(handler);
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, {
        ...request(),
        ancestorDirs: [],
      }),
    ).resolves.toEqual({ v: 1, trusted: [] });
    expect(resolveEntry).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    'ownership',
    'replacement',
    'effective-cwd',
    'workspace-cwd',
    'closing',
    'fence',
    'cwd-epoch',
  ])('discards a late grant after %s changes', async (change) => {
    const handler = vi.fn(async () => {
      if (change === 'ownership') owned = false;
      if (change === 'replacement') entry = { ...entry! };
      if (change === 'effective-cwd')
        entry!.effectiveCwd = path.dirname(directory);
      if (change === 'workspace-cwd')
        entry!.workspaceCwd = path.dirname(directory);
      if (change === 'closing') entry!.closing = true;
      if (change === 'fence') entry!.workspaceChangeFence = 1;
      if (change === 'cwd-epoch') entry!.cwdChangeEpoch = 2;
      return decision([true]);
    });
    const { client } = makeClient(handler);
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
    ).resolves.toEqual({ v: 1, trusted: [false] });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rechecks the effective cwd canonical path after a host decision', async () => {
    const alternate = path.join(directory, 'alternate');
    const target = path.join(directory, 'target');
    const alias = path.join(directory, 'alias');
    await fs.mkdir(alternate);
    await fs.mkdir(target);
    await fs.symlink(target, alias, 'junction');
    entry!.effectiveCwd = alias;
    const handler = vi.fn(async () => {
      await fs.unlink(alias);
      await fs.symlink(alternate, alias, 'junction');
      return decision([true]);
    });
    const { client } = makeClient(handler);
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, {
        ...request(),
        canonicalTargetDir: target,
      }),
    ).resolves.toEqual({ v: 1, trusted: [false] });
  });

  it('discards an ancestor grant revoked during the final canonical path probe', async () => {
    let published = true;
    let finishProbe!: (value: string) => void;
    const finalProbe = new Promise<string>((resolve) => {
      finishProbe = resolve;
    });
    const handler = vi.fn(async () => ({
      trusted: [published],
      isCurrent: () => published,
    }));
    const { client } = makeClient(handler);
    const realpath = vi
      .spyOn(fs, 'realpath')
      .mockImplementationOnce(async () => directory)
      .mockImplementationOnce(() => finalProbe);
    const result = client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request());
    await vi.waitFor(() => expect(realpath).toHaveBeenCalledTimes(2));
    published = false;
    finishProbe(directory);
    await expect(result).resolves.toEqual({ v: 1, trusted: [false] });
  });

  it.each(['missing', 'false', 'throwing', 'async'])(
    'denies a %s host freshness check',
    async (state) => {
      const handler = async () => ({
        trusted: [true],
        isCurrent:
          state === 'missing'
            ? undefined
            : state === 'async'
              ? async () => true
              : () => {
                  if (state === 'throwing') throw new Error('private policy');
                  return false;
                },
      });
      const { client } = makeClient(handler as WorkflowAncestorTrustHandler);
      await expect(
        client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
      ).resolves.toEqual({ v: 1, trusted: [false] });
    },
  );

  it.each([[], [true, true], [1], ['true'], new Array(1)])(
    'denies a malformed host result %#',
    async (trusted) => {
      const { client } = makeClient((async () =>
        decision(trusted as boolean[])) as WorkflowAncestorTrustHandler);
      await expect(
        client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
      ).resolves.toEqual({ v: 1, trusted: [false] });
    },
  );

  it('denies an unavailable directory or throwing hook without leaking details', async () => {
    const handler = vi.fn(async () => {
      throw new Error('private capability or policy content');
    });
    const { client } = makeClient(handler);
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
    ).resolves.toEqual({ v: 1, trusted: [false] });
    entry!.effectiveCwd = path.join(directory, 'missing');
    handler.mockClear();
    await expect(
      client.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, request()),
    ).resolves.toEqual({ v: 1, trusted: [false] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards the hook through the production bridge factory and fences foreign channels', async () => {
    const first = makeChannel();
    const second = makeChannel({ sessionIdPrefix: 'second' });
    const handler = vi.fn(async () => decision([true]));
    const firstBridge = makeBridge({
      boundWorkspace: directory,
      channelFactory: async () => first.channel,
      onWorkflowAncestorTrust: handler,
    });
    const secondBridge = makeBridge({
      boundWorkspace: directory,
      channelFactory: async () => second.channel,
      onWorkflowAncestorTrust: handler,
    });
    try {
      const session = await firstBridge.spawnOrAttach({
        workspaceCwd: directory,
      });
      await secondBridge.spawnOrAttach({
        workspaceCwd: directory,
      });
      await expect(
        first.agentConnection.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, {
          ...request(),
          sessionId: session.sessionId,
        }),
      ).resolves.toMatchObject({ trusted: [true] });
      expect(handler).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        workspaceCwd: directory,
        effectiveCwd: directory,
        canonicalTargetDir: directory,
        ancestorDirs: [path.dirname(directory)],
      });
      handler.mockClear();
      await expect(
        second.agentConnection.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, {
          ...request(),
          sessionId: session.sessionId,
        }),
      ).resolves.toMatchObject({ trusted: [false] });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await firstBridge.shutdown();
      await secondBridge.shutdown();
    }
  });

  it.each(['success', 'failure', 'cancelled'])(
    'invalidates pending grants during cd and recovers after %s',
    async (outcome) => {
      const nextCwd = path.join(directory, 'nested');
      await fs.mkdir(nextCwd);
      let releaseTrust!: () => void;
      const trustBlocked = new Promise<void>((resolve) => {
        releaseTrust = resolve;
      });
      let enteredTrust!: () => void;
      const trustEntered = new Promise<void>((resolve) => {
        enteredTrust = resolve;
      });
      let releaseCd!: () => void;
      const cdBlocked = new Promise<void>((resolve) => {
        releaseCd = resolve;
      });
      let enteredCd!: () => void;
      const cdEntered = new Promise<void>((resolve) => {
        enteredCd = resolve;
      });
      const handle = makeChannel({
        extMethodImpl: async (method) => {
          if (method === SERVE_CONTROL_EXT_METHODS.sessionCd) {
            enteredCd();
            await cdBlocked;
            if (outcome !== 'success') {
              throw new RequestError(
                outcome === 'cancelled' ? -32800 : -32603,
                outcome === 'cancelled' ? 'cd cancelled' : 'cd failed',
              );
            }
            return { previousCwd: directory, newCwd: nextCwd, warnings: [] };
          }
          return {};
        },
      });
      const handler = vi.fn(async () => {
        enteredTrust();
        await trustBlocked;
        return decision([true]);
      });
      const bridge = makeBridge({
        boundWorkspace: directory,
        channelFactory: async () => handle.channel,
        onWorkflowAncestorTrust: handler,
      });
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: directory });
        const query = (cwd = directory) =>
          handle.agentConnection.extMethod(WORKFLOW_ANCESTOR_TRUST_METHOD, {
            ...request(),
            sessionId: session.sessionId,
            canonicalTargetDir: cwd,
          });
        const pending = query();
        await trustEntered;
        const cd = bridge.changeSessionCwd(session.sessionId, {
          path: nextCwd,
        });
        const settledCd = cd.then(
          () => undefined,
          () => undefined,
        );
        await cdEntered;
        releaseTrust();
        await expect(pending).resolves.toMatchObject({ trusted: [false] });
        handler.mockClear();
        await expect(query()).resolves.toMatchObject({ trusted: [false] });
        expect(handler).not.toHaveBeenCalled();
        releaseCd();
        if (outcome === 'success')
          await expect(cd).resolves.toMatchObject({ newCwd: nextCwd });
        else
          await expect(cd).rejects.toMatchObject({
            code: outcome === 'cancelled' ? -32800 : -32603,
          });
        await settledCd;
        await expect(
          query(outcome === 'success' ? nextCwd : directory),
        ).resolves.toMatchObject({ trusted: [true] });
      } finally {
        releaseTrust();
        releaseCd();
        await bridge.shutdown();
      }
    },
  );
});
