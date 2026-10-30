/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import {
  readHiddenLine,
  runAgentsJoin,
  type HiddenInput,
  type JoinDeps,
} from './join.js';

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

function fakeTty(isTTY = true) {
  const emitter = new EventEmitter();
  const modes: boolean[] = [];
  const input: HiddenInput = {
    isTTY,
    isRaw: false,
    setRawMode: (raw) => modes.push(raw),
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    resume: () => undefined,
    pause: () => undefined,
  };
  const type = (text: string) => emitter.emit('data', Buffer.from(text));
  return { input, modes, type, emitter };
}

it('reads the enrollment token without echoing it', async () => {
  const { input, modes, type, emitter } = fakeTty();
  const written: string[] = [];

  const answer = readHiddenLine('Token: ', input, (text) => written.push(text));
  type('ab');
  type('x\u007fc');
  type('d\r');

  await expect(answer).resolves.toBe('abcd');
  // Raw mode on for the prompt, restored after; only the prompt and the
  // closing newline are written, never the typed characters.
  expect(modes).toEqual([true, false]);
  expect(written).toEqual(['Token: ', '\n']);
  expect(emitter.listenerCount('data')).toBe(0);
});

it('drops whole escape sequences instead of their printable tails', async () => {
  const keys = fakeTty();
  const typed = readHiddenLine('Token: ', keys.input, () => undefined);
  // Arrow keys, Delete and an SS3 Home key between real characters.
  keys.type('tok\u001b[A\u001b[D\u001b[3~\u001bOHen\r');
  await expect(typed).resolves.toBe('token');

  // Bracketed paste keeps the pasted text and drops both markers.
  const paste = fakeTty();
  const pasted = readHiddenLine('Token: ', paste.input, () => undefined);
  paste.type('\u001b[200~abc\u001b[201~\r');
  await expect(pasted).resolves.toBe('abc');
});

it('cancels the hidden prompt on Ctrl+C and skips it without a TTY', async () => {
  const tty = fakeTty();
  const cancelled = readHiddenLine('Token: ', tty.input, () => undefined);
  tty.type('secr\u0003');
  await expect(cancelled).resolves.toBeUndefined();
  expect(tty.modes).toEqual([true, false]);

  const piped = fakeTty(false);
  await expect(
    readHiddenLine('Token: ', piped.input, () => undefined),
  ).resolves.toBeUndefined();
  expect(piped.modes).toEqual([]);
});
