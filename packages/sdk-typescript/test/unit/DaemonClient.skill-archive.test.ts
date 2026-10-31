/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonSkillInstallError } from '../../src/daemon/DaemonSkillInstallError.js';

const id = '87ff2204-4713-49bf-929e-cc46e83ab710';
const result = {
  skillName: 'example',
  scope: 'global',
  attemptId: id,
  archiveSha256: 'a'.repeat(64),
  activation: 'deferred',
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('native Skill archive client', () => {
  it.each([false, true])(
    'sends a Blob directly to the selected owner (workspace=%s)',
    async (workspace) => {
      const data = new Blob(['zip bytes']);
      const fetch = vi.fn(async () =>
        Response.json({ ...result, scope: workspace ? 'workspace' : 'global' }),
      );
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        token: 'secret',
        fetch,
      });
      const selected = workspace ? client.workspaceByCwd('/secondary') : client;
      await selected.installWorkspaceConfigSkillArchive({
        name: 'example',
        data,
        attemptId: id,
      });
      const [url, options] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(
        `http://daemon${workspace ? '/workspaces/%2Fsecondary' : '/workspace'}/config/skills/install-archive?name=example&attemptId=${id}`,
      );
      expect(options.body).toBe(data);
      expect(new Headers(options.headers).get('authorization')).toBe(
        'Bearer secret',
      );
      expect(new Headers(options.headers).get('content-type')).toBe(
        'application/octet-stream',
      );
    },
  );

  it('generates an attempt before a response exists, preserves its cause, and never retransmits', async () => {
    const cause = new TypeError('connection lost');
    const fetch = vi.fn(async (_input: RequestInfo | URL) => {
      throw cause;
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const error = await client
      .installWorkspaceConfigSkillArchive({
        name: 'example',
        data: new Uint8Array([1]),
      })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DaemonSkillInstallError);
    if (!(error instanceof DaemonSkillInstallError)) throw error;
    expect(error.attemptId).toMatch(/^[a-f0-9]{8}-[a-f0-9-]{27}$/);
    expect(error.cause).toBe(cause);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(error.attemptId);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sends zip-file only through config and retains HTTP failure details', async () => {
    const body = {
      code: 'skill_archive_digest_mismatch',
      error: 'digest mismatch',
    };
    const fetch = vi.fn(async () => Response.json(body, { status: 400 }));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const error = await client
      .installWorkspaceConfigSkill({
        name: 'example',
        scope: 'global',
        attemptId: id,
        source: { type: 'zip-file', path: '/daemon/archive.zip' },
      })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ attemptId: id, status: 400, body });
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://daemon/workspace/config/skills/install');
    expect(JSON.parse(String(options.body))).toMatchObject({
      attemptId: id,
      source: { type: 'zip-file', path: '/daemon/archive.zip' },
    });
  });

  it('uses a 130 second default even when the client default is shorter', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          ),
        ),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
      fetchTimeoutMs: 5,
    });
    let settled = false;
    const operation = client
      .installWorkspaceConfigSkillArchive({
        name: 'example',
        data: new Uint8Array([1]),
        attemptId: id,
      })
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    await vi.advanceTimersByTimeAsync(129_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await operation).toMatchObject({
      attemptId: id,
      cause: { name: 'TimeoutError' },
    });
  });

  it('allows timeout 0 while preserving caller cancellation and an independent receipt query', async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetch = vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      signals.push(options?.signal);
      if (signals.length > 1)
        return Promise.resolve(
          Response.json({
            ...result,
            state: 'committed',
            phase: 'cleanup',
            workspaceId: 'owner',
          }),
        );
      return new Promise<Response>((_resolve, reject) =>
        options?.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        ),
      );
    });
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
      fetchTimeoutMs: 5,
    });
    const controller = new AbortController();
    const operation = client
      .installWorkspaceConfigSkillArchive({
        name: 'example',
        data: new Uint8Array([1]),
        attemptId: id,
        timeoutMs: 0,
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(130_001);
    expect(signals[0]?.aborted).toBe(false);
    controller.abort();
    expect(await operation).toMatchObject({
      attemptId: id,
      cause: { name: 'AbortError' },
    });
    expect(
      await client.getWorkspaceSkillInstallAttempt(id, { timeoutMs: 5000 }),
    ).toMatchObject({ state: 'committed' });
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an unknown receipt from inaccessible ownership', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'skill_install_attempt_unknown' },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ code: 'workspace_mismatch' }, { status: 404 }),
      );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.workspaceByCwd('/secondary').getWorkspaceSkillInstallAttempt(id),
    ).resolves.toBeUndefined();
    await expect(
      client.workspaceByCwd('/secondary').getWorkspaceSkillInstallAttempt(id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([undefined, 0])(
    'uses XHR progress with native result validation and timeout %s',
    async (timeoutMs) => {
      class XHR {
        static latest: XHR;
        status = 200;
        responseText = JSON.stringify(result);
        timeout = 0;
        upload: { onprogress?: (event: Partial<ProgressEvent>) => void } = {};
        onload?: () => void;
        onerror?: () => void;
        ontimeout?: () => void;
        onabort?: () => void;
        open = vi.fn();
        setRequestHeader = vi.fn();
        send = vi.fn();
        abort() {
          this.onabort?.();
        }
        constructor() {
          XHR.latest = this;
        }
      }
      vi.stubGlobal('XMLHttpRequest', XHR);
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetchTimeoutMs: 7,
      });
      const progress = vi.fn();
      const operation = client.installWorkspaceConfigSkillArchive({
        name: 'example',
        data: new Blob(['zip']),
        attemptId: id,
        timeoutMs,
        onProgress: progress,
      });
      expect(XHR.latest.timeout).toBe(timeoutMs === 0 ? 0 : 130_000);
      XHR.latest.upload.onprogress?.({
        lengthComputable: true,
        loaded: 3,
        total: 3,
      });
      expect(progress).toHaveBeenCalledWith({ loaded: 3, total: 3 });
      XHR.latest.onload?.();
      await expect(operation).resolves.toEqual(result);
    },
  );
});
