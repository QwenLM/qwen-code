/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it, vi } from 'vitest';
import { runAgentsJoin, type JoinDeps } from './join.js';

function deps(overrides: Partial<JoinDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: JoinDeps = {
    fetch: vi.fn(async () =>
      Response.json({ connected: true, providers: ['qwen', 'claude'] }),
    ) as unknown as typeof fetch,
    env: { QWEN_AGENT_HOST_ENROLLMENT_TOKEN: ' join-token ' },
    cwd: '/work/repo',
    promptToken: vi.fn(async () => undefined),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { value, out, err };
}

it('asks the local daemon to connect with the link and token', async () => {
  const { value, out } = deps({
    env: {
      QWEN_AGENT_HOST_ENROLLMENT_TOKEN: ' join-token ',
      QWEN_SERVER_TOKEN: 'daemon-token',
    },
  });

  const code = await runAgentsJoin(
    { link: 'https://hub.example:4170/join/ws_1', 'allow-http': false },
    value,
  );

  expect(code).toBe(0);
  const [url, init] = vi.mocked(value.fetch).mock.calls[0]!;
  expect(url).toBe(
    'http://127.0.0.1:4170/workspaces/%2Fwork%2Frepo/agent/hosts/connect',
  );
  expect(init?.headers).toMatchObject({
    authorization: 'Bearer daemon-token',
  });
  expect(JSON.parse(init?.body as string)).toEqual({
    serverUrl: 'https://hub.example:4170',
    workspaceId: 'ws_1',
    enrollmentToken: 'join-token',
    allowHttp: false,
  });
  expect(out.join('\n')).toContain('qwen, claude');
});

it('points at `qwen serve --join` when no daemon is running', async () => {
  const { value, err } = deps({
    fetch: vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });

  const code = await runAgentsJoin(
    { link: 'http://10.0.0.2:4170/join/ws_1', 'allow-http': true },
    value,
  );

  expect(code).toBe(1);
  expect(err.join('\n')).toContain(
    'qwen serve --join http://10.0.0.2:4170/join/ws_1 --agent-host-allow-http',
  );
});

it('prompts for the token when the environment has none, and refuses without one', async () => {
  const promptToken = vi.fn(async () => undefined);
  const { value, err } = deps({ env: {}, promptToken });

  expect(
    await runAgentsJoin({ link: 'https://hub.example/join/ws_1' }, value),
  ).toBe(1);
  expect(promptToken).toHaveBeenCalledOnce();
  expect(value.fetch).not.toHaveBeenCalled();
  expect(err.join('\n')).toContain('QWEN_AGENT_HOST_ENROLLMENT_TOKEN');
});

it('reports the daemon’s refusal and a malformed link', async () => {
  const { value, err } = deps({
    fetch: vi.fn(async () =>
      Response.json(
        { error: 'Invalid or expired Agent Host enrollment token.' },
        { status: 400 },
      ),
    ) as unknown as typeof fetch,
  });

  expect(
    await runAgentsJoin({ link: 'https://hub.example/join/ws_1' }, value),
  ).toBe(1);
  expect(err.join('\n')).toContain('expired');

  expect(await runAgentsJoin({ link: 'not a link' }, value)).toBe(1);
});
