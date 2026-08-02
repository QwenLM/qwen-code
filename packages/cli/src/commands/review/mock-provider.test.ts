/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The fixture half of 94 hand-written mock servers: SSE framing (93%), a
// `[DONE]` terminator (92%), `/v1/chat/completions` (73%), a usage block (69%),
// a request log (62%). Driven here over real HTTP, because a mock asserted
// against its own helper functions proves only that the helpers agree with
// themselves — the client this exists for speaks the wire.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startMockProvider,
  chunksFor,
  completionFor,
  messagesText,
  type Responder,
} from './mock-provider.js';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function serve(respond: Responder) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  const log = join(dir, 'req.jsonl');
  const { report, close } = await startMockProvider({ log, ttl: 60 }, respond);
  stop = close;
  return { report, log };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the port', () => {
  it('comes from the OS, not from the caller', async () => {
    // 67 of 94 mocks read a port from an env var — a number someone chose and
    // hoped was free. Two reviews on one machine then collide, and the second
    // one's failure looks like the product's.
    const a = await serve(() => ({ text: 'a' }));
    expect(a.report.port).toBeGreaterThan(0);
    expect(a.report.baseUrl).toContain(String(a.report.port));
    const first = a.report.port;
    await stop?.();
    const b = await serve(() => ({ text: 'b' }));
    expect(b.report.port).toBeGreaterThan(0);
    expect(b.report.port).not.toBe(first);
  });
});

describe('the wire', () => {
  it('streams a text reply as SSE chunks ending in [DONE]', async () => {
    const { report } = await serve(() => ({ text: 'hello there' }));
    const body = await (
      await post(report.baseUrl, { stream: true, messages: [] })
    ).text();
    expect(body).toContain('data: ');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const first = JSON.parse(body.split('\n\n')[0].slice('data: '.length));
    expect(first.choices[0].index).toBe(0);
    expect(body).toContain('"finish_reason":"stop"');
  });

  it('streams a tool call with the chunk index the protocol requires', async () => {
    // Unanimous across all 41 hand-written mocks that emitted one — which is
    // exactly what makes it a fixture and not a choice.
    const { report } = await serve(() => ({
      tool: 'run_shell_command',
      args: { command: 'ls' },
    }));
    const body = await (
      await post(report.baseUrl, { stream: true, messages: [] })
    ).text();
    // Parsed, not grepped: `"index":0` also appears on every `choices` entry,
    // so a substring assertion passes with the tool_call index removed — it did.
    const chunks = body
      .split('\n\n')
      .filter((b) => b.startsWith('data: ') && !b.includes('[DONE]'))
      .map((b) => JSON.parse(b.slice('data: '.length)));
    const call = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
      .at(0);
    expect(call).toBeDefined();
    expect(call.index).toBe(0);
    expect(call.type).toBe('function');
    expect(call.function.name).toBe('run_shell_command');
    expect(JSON.parse(call.function.arguments)).toEqual({ command: 'ls' });
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('[DONE]');
  });

  it('answers a NON-stream request as a completion, with a usage block', async () => {
    // 20% of the corpus classified side queries by `stream !== true`; a client
    // that reads token counts behaves differently without `usage`, and that
    // difference would be the mock's, not the diff's.
    const { report } = await serve(() => ({ text: 'side' }));
    const json = (await (
      await post(report.baseUrl, { stream: false, messages: [] })
    ).json()) as Record<string, never>;
    expect(json['object']).toBe('chat.completion');
    expect(json['usage']).toBeDefined();
    expect(json['choices'][0]['message']['content']).toBe('side');
  });

  it('lets a responder answer with a status — the injection half', async () => {
    const { report } = await serve(() => ({
      status: 429,
      body: { error: 'slow down' },
    }));
    const res = await post(report.baseUrl, { stream: true, messages: [] });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('slow down');
  });

  it('serves /v1/models without troubling the responder', async () => {
    let asked = 0;
    const { report } = await serve(() => {
      asked++;
      return { text: 'x' };
    });
    const res = await fetch(`${report.baseUrl}/models`);
    expect(res.status).toBe(200);
    expect(asked).toBe(0);
  });
});

describe('the record', () => {
  it('appends one parseable JSON line per request, in order', async () => {
    // This is where an A/B gets its evidence: the same drive against two trees,
    // and a diff of the two request sequences. It only works if both sides
    // write the same shape.
    const { report, log } = await serve((r) => ({ text: `n=${r.n}` }));
    await post(report.baseUrl, {
      stream: true,
      messages: [{ role: 'user', content: 'one' }],
    });
    await post(report.baseUrl, {
      stream: false,
      messages: [{ role: 'user', content: 'two' }],
    });
    await stop?.();
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs.map((r) => r.n)).toEqual([1, 2]);
    expect(recs[0].text).toBe('one');
    expect(recs[0].stream).toBe(true);
    expect(recs[1].stream).toBe(false);
    expect(recs[0].reply).toEqual({ text: 'n=1' });
  });

  it('starts empty, so one run cannot read the previous run as its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-'));
    const log = join(dir, 'req.jsonl');
    writeFileSync(log, '{"stale":true}\n');
    const { report, close } = await startMockProvider({ log, ttl: 60 }, () => ({
      text: 'x',
    }));
    stop = close;
    await post(report.baseUrl, { stream: true, messages: [] });
    await stop?.();
    stop = null;
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('stale');
  });

  it('records a responder that threw, and answers 500 rather than a fake 200', async () => {
    // Hiding the caller's bug behind a plausible reply makes the drive look
    // like a product failure.
    const { report, log } = await serve(() => {
      throw new Error('responder blew up');
    });
    const res = await post(report.baseUrl, { stream: true, messages: [] });
    expect(res.status).toBe(500);
    await stop?.();
    expect(readFileSync(log, 'utf8')).toContain('responder blew up');
  });
});

describe('the pieces, without a socket', () => {
  it('flattens both message content shapes', () => {
    expect(
      messagesText({
        messages: [
          { content: 'a' },
          { content: [{ text: 'b' }, { text: 'c' }] },
        ],
      }),
    ).toBe('a\nbc');
    expect(messagesText(null)).toBe('');
  });

  it('a text reply ends in stop, a tool reply ends in tool_calls', () => {
    expect(chunksFor({ text: 'x' }).at(-1)).toMatchObject({
      choices: [{ finish_reason: 'stop' }],
    });
    expect(chunksFor({ tool: 't' }).at(-1)).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }],
    });
    expect(completionFor({ tool: 't', args: { a: 1 } })).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }],
    });
  });
});
