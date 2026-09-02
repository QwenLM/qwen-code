/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen-live M1 — one full call, end to end, against real subprocesses:
 * a real `qwen serve` (model side backed by the fake OpenAI server), the
 * real `qwen-live` daemon binary, a fake DashScope realtime endpoint, and
 * a protocol-v6 FakeHost.
 *
 *   a. the discovery file exists with the documented fields;
 *   b. FakeHost connect → hello → host.welcome;
 *   c. `toggle` opens the realtime connection (auth header + model query),
 *      sends session.update with the 8-tool surface, and the call reaches
 *      `listening`;
 *   d. direct-answer path: Host input audio frames reach the provider as
 *      input_audio_buffer.append, provider output audio reaches the Host as
 *      bare PCM frames;
 *   e. handoff path: a handoff function call lands on the real serve daemon
 *      as a prompt; the receipt (function_call_output), the [COMPLETE]
 *      context injection, and the [SPEAK_TO_USER] + response.create speech
 *      request all arrive on the provider socket in order;
 *   f. SIGTERM removes the discovery file.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contextTextOf,
  functionCallOutputOf,
  type FakeDashScopeConnection,
} from './fake-dashscope-server.js';
import {
  bootLiveStack,
  liveDiscoveryPath,
  QWEN_LIVE_API_KEY,
  QWEN_LIVE_REALTIME_MODEL,
  type LiveStack,
} from './qwen-live-harness.js';

// Windows: the harness relies on POSIX process semantics (SIGTERM shutdown
// path is part of scenario f). Container sandboxes: the serve daemon's ACP
// child cannot reach the host-loopback fake OpenAI server (same skip as
// qwen-serve-streaming.test.ts).
const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
  );
const describeE2E = SKIP ? describe.skip : describe;

const EXPECTED_TOOL_NAMES = [
  'appshot',
  'handoff',
  'remain_silent',
  'respond_permission',
  'session_create',
  'session_list',
  'session_monitor',
  'session_stop',
];

describeE2E('qwen-live M1 — end-to-end voice call', () => {
  let stack: LiveStack;
  let conn: FakeDashScopeConnection;
  let callEpoch = 0;

  beforeAll(async () => {
    stack = await bootLiveStack({
      makeOpenAIHandler: () => () => ({
        content: 'm1 backend turn complete',
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await stack?.dispose();
  }, 60_000);

  it('publishes a discovery record with the documented fields', async () => {
    const record = JSON.parse(
      await readFile(liveDiscoveryPath(stack.discoveryDir), 'utf8'),
    ) as Record<string, unknown>;
    expect(record['url']).toBe(stack.live.url);
    expect(typeof record['token']).toBe('string');
    expect(String(record['token']).length).toBeGreaterThan(0);
    expect(record['protocolVersion']).toBe(6);
    expect(record['pid']).toBe(stack.live.proc.pid);
    expect(String(record['instanceNonce'])).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
  });

  it('answers host.hello with host.welcome', () => {
    const welcome = stack.host.states.find(
      (entry) => entry.type === 'host.welcome',
    );
    expect(welcome).toBeDefined();
    expect(Number.isInteger(welcome!.epoch)).toBe(true);
    expect(welcome!.status['available']).toBe(true);
    expect(welcome!.status['state']).toBe('idle');
  });

  it('toggle connects to the realtime provider and reaches listening', async () => {
    const stateIndex = stack.host.states.length;
    const connection = stack.fakeDash.waitForConnection(20_000);
    stack.host.action('toggle');
    conn = await connection;

    expect(conn.authorization).toBe(`Bearer ${QWEN_LIVE_API_KEY}`);
    expect(conn.model).toBe(QWEN_LIVE_REALTIME_MODEL);
    expect(conn.requestUrl).toContain('/api-ws/v1/realtime');

    const update = await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'session.update',
      { timeoutMs: 10_000, description: 'session.update' },
    );
    const session = update['session'] as Record<string, unknown>;
    const tools = session['tools'] as Array<{
      type: string;
      function: { name: string };
    }>;
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(
      EXPECTED_TOOL_NAMES,
    );
    expect(typeof session['instructions']).toBe('string');
    expect(String(session['instructions']).length).toBeGreaterThan(0);

    const listening = await stack.host.waitForState(
      (entry) => entry.status['state'] === 'listening',
      { timeoutMs: 20_000, fromIndex: stateIndex },
    );
    callEpoch = listening.epoch;
    expect(callEpoch).toBeGreaterThan(0);
  });

  it('routes Host input audio up and provider output audio down', async () => {
    const pcmIn = Buffer.alloc(3_200);
    for (let i = 0; i < pcmIn.length; i++) pcmIn[i] = i % 251;
    const inboxIndex = stack.fakeDash.inbox.length;
    stack.host.sendAudio(callEpoch, pcmIn);
    const append = await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'input_audio_buffer.append',
      { fromIndex: inboxIndex, description: 'input_audio_buffer.append' },
    );
    expect(Buffer.from(String(append['audio']), 'base64').equals(pcmIn)).toBe(
      true,
    );

    const pcmOut = Buffer.alloc(4_800);
    for (let i = 0; i < pcmOut.length; i++) pcmOut[i] = (i * 7) % 253;
    const framesBefore = stack.host.audioFrames.length;
    conn.respondWithAudio(pcmOut);
    const frame = await stack.host.waitForAudioFrame({
      fromIndex: framesBefore,
    });
    expect(frame.equals(pcmOut)).toBe(true);
  });

  it('hands off to the real serve daemon and injects the result back', async () => {
    const inboxIndex = stack.fakeDash.inbox.length;
    conn.speakTranscript('fix the failing test');
    conn.functionCall({
      name: 'handoff',
      argumentsJson: '{"task":"fix the failing test"}',
      callId: 'call-1',
    });

    // Receipt: the handoff was admitted by qwen serve.
    const receiptMessage = await stack.fakeDash.waitForMessage(
      (message) => functionCallOutputOf(message)?.callId === 'call-1',
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the handoff function_call_output receipt',
      },
    );
    const receipt = JSON.parse(
      functionCallOutputOf(receiptMessage)!.output,
    ) as Record<string, unknown>;
    expect(receipt['status']).toBe('accepted');
    expect(receipt['job']).toBe('job_1');

    // The real serve daemon received the prompt (model side = fake OpenAI).
    await expect
      .poll(
        () =>
          stack.fakeOpenAI.requests.some((request) =>
            JSON.stringify(request.body['messages'] ?? []).includes(
              'fix the failing test',
            ),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The turn's conclusion flows back as a silent [COMPLETE] context item…
    const completeMessage = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && text.includes('[COMPLETE job_1]');
      },
      {
        timeoutMs: 30_000,
        fromIndex: inboxIndex,
        description: 'the [COMPLETE job_1] context injection',
      },
    );
    const completeText = contextTextOf(completeMessage)!;
    expect(completeText).toMatch(/^\[BACKEND\] /);
    expect(completeText).toContain('m1 backend turn complete');
    expect(stack.fakeDash.inbox.indexOf(receiptMessage)).toBeLessThan(
      stack.fakeDash.inbox.indexOf(completeMessage),
    );

    // …and as a spoken line: a [SPEAK_TO_USER] item followed by
    // response.create (speakToUser wire shape in realtime-session.ts).
    const speakMessage = await stack.fakeDash.waitForMessage(
      (message) => {
        const text = contextTextOf(message);
        return text !== undefined && text.startsWith('[SPEAK_TO_USER] ');
      },
      {
        timeoutMs: 15_000,
        fromIndex: inboxIndex,
        description: 'the [SPEAK_TO_USER] speech request item',
      },
    );
    expect(contextTextOf(speakMessage)).toContain(
      'task to fix the failing test finished',
    );
    expect(contextTextOf(speakMessage)).not.toContain('job_1');
    const speakIndex = stack.fakeDash.inbox.indexOf(speakMessage);
    await stack.fakeDash.waitForMessage(
      (message) => message['type'] === 'response.create',
      {
        timeoutMs: 15_000,
        fromIndex: speakIndex,
        description: 'the response.create following [SPEAK_TO_USER]',
      },
    );
  });

  it('removes the discovery file on SIGTERM', async () => {
    const discoveryFile = liveDiscoveryPath(stack.discoveryDir);
    expect(existsSync(discoveryFile)).toBe(true);
    await stack.live.dispose(); // SIGTERM → graceful stop
    expect(existsSync(discoveryFile)).toBe(false);
  });
});
