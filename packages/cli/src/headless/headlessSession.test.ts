/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX, parseSdkInputBlock } from '@qwen-code/core';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@qwen-code/core';
import {
  HeadlessSession,
  type HeadlessSessionParams,
} from './headlessSession.js';
import type { ThreadHost } from '../thread-manager/thread-session/contract/hostContext.js';

function createSession() {
  const result = { type: 'result', subtype: 'success' } as SDKMessage;
  const manager = {
    requireSession: () => ({ signal: new AbortController().signal }),
    submitMessage: vi.fn(async (..._args: unknown[]) =>
      session['resolveTurn'](result),
    ),
  };
  const session = new HeadlessSession({
    settings: { merged: {} },
    cliArgs: {},
    threadManager: manager,
    workspaceRoot: '/workspace',
  } as unknown as HeadlessSessionParams);
  session['openedSessionId'] = 'test-session';
  session['host'] = {} as ThreadHost;
  return { session, manager, result };
}

describe('headless stream-json user content', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
  };

  it.each(
    [
      [image],
      [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'last' }],
      [
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/a.png' },
        },
      ],
    ].map((content) => ({ content })),
  )(
    'passes structured content intact to ThreadManager: %j',
    async ({ content: blocks }) => {
      const { session, manager, result } = createSession();
      const parsed = session['tryParseUserPrompt']({
        message: { content: blocks.map(block => parseSdkInputBlock(block)) },
      });
      await expect(session['submitTurn'](parsed!)).resolves.toBe(result);
      expect(manager.submitMessage.mock.calls[0]?.[2]).toMatchObject({
        type: 'user',
        message: { role: 'user', content: blocks.map(block => parseSdkInputBlock(block)) },
      });
    },
  );

  it('keeps plain prompts and legacy string entries working', async () => {
    const { session, manager } = createSession();
    await session['submitTurn']('hello');
    expect(manager.submitMessage.mock.calls[0]?.[2]).toMatchObject({
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(session['tryParseUserPrompt']({ message: { content: 'hello' } })).toBe(
      'hello',
    );
    expect(
      session['tryParseUserPrompt']({ message: { content: ['hello', image] } }),
    ).toEqual([{ type: 'text', text: 'hello' }, parseSdkInputBlock(image)]);
  });

  it.each(
    [
      [null],
      [{ type: 'text', text: 1 }],
    ].map((content) => ({ content })),
  )('rejects invalid or empty content: %j', ({ content }) => {
    const { session } = createSession();
    expect(() =>
      session['tryParseUserPrompt']({ message: { content } }),
    ).toThrow();
  });
});

describe('headless background wind-down policy', () => {
  const envName = `${BRAND_FIXED_ENV_PREFIX.replace(/_$/, '')}CLI_PRINT_BG_WAIT_CEILING_MS`;

  beforeEach(() => vi.stubEnv(envName, undefined));
  afterEach(() => vi.unstubAllEnvs());

  it('hard-bounds shutdown so a running background task cannot hang -p', () => {
    // A foreground process has no external host to wind it down, so the
    // daemon's 10s bound must apply to -p too; otherwise a background task
    // that never exits keeps the CLI alive for the full 600s wait ceiling.
    const { session } = createSession();
    expect(session['backgroundWindDownPolicy']()).toEqual({
      waitCeilingMs: 600_000,
      boundMs: 10_000,
    });
  });

  it.each([
    ['30000', 30_000],
    ['0', 0],
  ])('honors explicit wait %s without a hard bound', (raw, expected) => {
    vi.stubEnv(envName, raw);
    const { session } = createSession();
    expect(session['backgroundWindDownPolicy']()).toEqual({
      waitCeilingMs: expected,
    });
  });
});
