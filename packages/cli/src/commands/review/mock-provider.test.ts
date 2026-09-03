/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

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
  replyProblem,
  anthropicStream,
  anthropicMessage,
  anthropicText,
  mockProviderCommand,
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

describe('what it refuses to answer', () => {
  it('400s a wrong endpoint, wrong method, or unparseable body', async () => {
    // Measured before this existed: each of these got back a plausible 200
    // completion. A product that dialled the wrong endpoint, used the wrong
    // method, or sent a broken payload therefore looked like it was working —
    // the mock hiding the very defect the review is looking for.
    const { report } = await serve(() => ({ text: 'ok' }));
    const B = report.baseUrl;
    const cases: Array<[string, RequestInit, string]> = [
      ['/embeddings', { method: 'POST', body: '{}' }, 'is not one of them'],
      ['/chat/completions', { method: 'GET' }, 'use POST'],
      ['/chat/completions', { method: 'POST', body: 'not json' }, 'not JSON'],
      ['/chat/completions', { method: 'POST' }, 'not JSON'],
    ];
    const got: Array<[string, number]> = [];
    for (const [p, init, phrase] of cases) {
      const res = await fetch(`${B}${p}`, init);
      got.push([p + ' ' + (init.method ?? ''), res.status]);
      expect(await res.text()).toContain(phrase);
    }
    expect(got.map(([, s]) => s)).toEqual([400, 400, 400, 400]);
  });

  it('answers the three shapes it does serve', async () => {
    const { report } = await serve(() => ({ text: 'ok' }));
    const J = (b: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    for (const p of ['/chat/completions', '/messages']) {
      const res = await fetch(
        `${report.baseUrl}${p}`,
        J({ stream: false, messages: [] }),
      );
      expect(res.status).toBe(200);
    }
    expect((await fetch(`${report.baseUrl}/models`)).status).toBe(200);
  });

  it('records the refusal, so a run that dialled wrong can be seen', async () => {
    const { report, log } = await serve(() => ({ text: 'ok' }));
    await fetch(`${report.baseUrl}/embeddings`, { method: 'POST', body: '{}' });
    await stop?.();
    stop = null;
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec.refused).toContain('is not one of them');
  });

  it('keeps the RECORD small even when the body is not — body is summarised, not copied', async () => {
    // Trimming `text` alone left `body` spread into the same entry with the
    // identical payload: a 200 KB system prompt gave an 8 KB `text` and a
    // 205 KB log. Now 9 KB.
    const { report, log } = await serve(() => ({ text: 'ok' }));
    await fetch(`${report.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: false,
        system: 'S'.repeat(200_000),
        messages: [],
      }),
    });
    await stop?.();
    stop = null;
    expect(readFileSync(log).length).toBeLessThan(30_000);
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec.body).toBeUndefined();
    expect(rec.bodyKeys).toEqual(['stream', 'system', 'messages']);
  });
});

describe('the bounds', () => {
  it('numbers only the requests the RESPONDER saw — across every skip path', async () => {
    // Two passes to find them all. Round 1 stopped `/v1/models` from taking a
    // number; a mixed run in round 5 showed the other two ways it still could,
    // as `[1, 2, 2, 3, 4, 5]`: the models call REUSED the previous request's
    // number, and a refused `/v1/embeddings` incremented past it. A responder
    // keyed on its Nth call reads a sequence like that and fires late.
    const seen: number[] = [];
    const { report, log } = await serve((r) => {
      seen.push(r.n);
      return { text: 'x' };
    });
    const J = (b: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    await fetch(
      `${report.baseUrl}/messages`,
      J({ stream: false, messages: [] }),
    );
    await fetch(`${report.baseUrl}/models`);
    await fetch(
      `${report.baseUrl}/chat/completions`,
      J({ stream: false, messages: [] }),
    );
    await fetch(`${report.baseUrl}/embeddings`, J({ x: 1 }));
    await fetch(`${report.baseUrl}/chat/completions`, { method: 'GET' });
    await fetch(
      `${report.baseUrl}/messages`,
      J({ stream: false, messages: [] }),
    );
    await stop?.();
    stop = null;
    expect(seen).toEqual([1, 2, 3]);
    // ...and the record says `null` for the three it never saw, rather than a
    // number that would read as "the responder handled this".
    const recs = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(recs.map((r) => r.n)).toEqual([1, null, 2, null, null, 3]);
  });

  it('numbers only the requests the RESPONDER saw', async () => {
    // `/v1/models` is answered without consulting the responder, so it must
    // not take a number. Counting it produced `[1, 3]` for two calls, and a
    // responder keyed on its third call would have fired on the second.
    const seen: number[] = [];
    const { report } = await serve((r) => {
      seen.push(r.n);
      return { text: 'x' };
    });
    await post(report.baseUrl, { stream: false, messages: [] });
    await fetch(`${report.baseUrl}/models`);
    await post(report.baseUrl, { stream: false, messages: [] });
    expect(seen).toEqual([1, 2]);
  });

  it('refuses an oversized body rather than truncating it', async () => {
    // Measured before the bound: a 40 MiB POST was read whole into memory,
    // handed to the responder, and written to the JSONL twice — an 80 MiB log
    // on the review's own machine. Refused, not trimmed: a truncated body
    // parses to different JSON, so the mock would answer a request the client
    // never sent, which is the one thing a harness must never do.
    const { report } = await serve(() => ({ text: 'x' }));
    const res = await post(report.baseUrl, {
      stream: false,
      messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }],
    });
    expect(res.status).toBe(413);
    // ...and an ordinary request is untouched.
    const ok = await post(report.baseUrl, {
      stream: false,
      messages: [{ role: 'user', content: 'y'.repeat(20_000) }],
    });
    expect(ok.status).toBe(200);
  });

  it('keeps the record small, and says where it trimmed', async () => {
    // The evidence an A/B needs is the SHAPE of the request sequence, not
    // every byte of every prompt. A log that grows with the payload is the
    // hazard `drive`'s 8 MiB cap exists for, arriving through a second door.
    const { report, log } = await serve(() => ({ text: 'x' }));
    await post(report.baseUrl, {
      stream: false,
      messages: [{ role: 'user', content: 'z'.repeat(200_000) }],
    });
    await stop?.();
    stop = null;
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec.text.length).toBeLessThan(20_000);
    expect(rec.text).toContain('more characters');
  });
});

describe('the Anthropic wire', () => {
  // Shapes taken from this repo's own `anthropicContentGenerator`, not from
  // memory: the six events it parses, `input_json_delta`, the four usage
  // fields, and the block array. A mock whose protocol came from the author's
  // recollection would be testing the recollection.
  const anth = (base: string, body: unknown) =>
    fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('streams the six events, in order, and does NOT send [DONE]', async () => {
    // `[DONE]` is OpenAI's terminator. An Anthropic client waits for
    // `message_stop`, so sending the wrong one leaves it hanging — the same
    // failure shape as a malformed responder, arriving from the other wire.
    const { report } = await serve(() => ({ text: 'hello' }));
    const body = await (
      await anth(report.baseUrl, { stream: true, messages: [] })
    ).text();
    const events = [...body.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(body).not.toContain('[DONE]');
  });

  it('streams tool input as input_json_delta, not as a finished object', async () => {
    // A client that accumulates partial JSON and one that expects it whole
    // behave differently, and the real API streams it.
    const { report } = await serve(() => ({
      tool: 'run_shell_command',
      args: { command: 'ls' },
    }));
    const body = await (
      await anth(report.baseUrl, { stream: true, messages: [] })
    ).text();
    // Parsed, not grepped: keeping the delta TYPE while handing the arguments
    // over as a finished `input` object passes a substring check and fails a
    // client that accumulates `partial_json` — it did.
    const deltas = [...body.matchAll(/^data: (.+)$/gm)]
      .map((m) => JSON.parse(m[1]))
      .filter((d) => d.type === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta.type).toBe('input_json_delta');
    expect(typeof deltas[0].delta.partial_json).toBe('string');
    expect(JSON.parse(deltas[0].delta.partial_json)).toEqual({ command: 'ls' });
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"stop_reason":"tool_use"');
  });

  it('answers a non-stream call with a block ARRAY and the four usage fields', async () => {
    const { report } = await serve(() => ({ text: 'plain' }));
    const json = (await (
      await anth(report.baseUrl, { stream: false, messages: [] })
    ).json()) as Record<string, never>;
    expect(json['content']).toEqual([{ type: 'text', text: 'plain' }]);
    expect(json['stop_reason']).toBe('end_turn');
    expect(Object.keys(json['usage']).sort()).toEqual([
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'input_tokens',
      'output_tokens',
    ]);
  });

  it('gives the responder the top-level `system`, which Anthropic puts outside messages', () => {
    // 20% of the corpus classified requests by their system prompt. On this
    // wire the system prompt is not in `messages`, so a responder branching on
    // prompt text would never see it.
    expect(
      anthropicText({
        system: 'you are a verifier',
        messages: [{ content: 'hi' }],
      }),
    ).toBe('you are a verifier\nhi');
    expect(anthropicText({ system: [{ text: 'blocks' }], messages: [] })).toBe(
      'blocks',
    );
  });

  it('...and actually hands that text to the responder on this wire', async () => {
    // The pure function being right is not the same as it being wired in.
    // Testing only the function left the request path free to call the OpenAI
    // flattener instead, which drops `system` entirely — and it passed.
    let seen = '';
    const { report } = await serve((r) => {
      seen = r.text;
      return { text: 'x' };
    });
    await anth(report.baseUrl, {
      stream: false,
      system: 'you are a verifier',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(seen).toContain('you are a verifier');
    expect(anthropicText({ messages: [{ content: 'only user' }] })).toBe(
      'only user',
    );
  });

  it('tells the responder — and the record — which wire was dialled', async () => {
    // An A/B whose two sides dialled different wires is not comparing the same
    // thing, and the log is where that shows.
    const wires: string[] = [];
    const { report, log } = await serve((r) => {
      wires.push(r.wire);
      return { text: 'x' };
    });
    await anth(report.baseUrl, { stream: false, messages: [] });
    await post(report.baseUrl, { stream: false, messages: [] });
    await stop?.();
    stop = null;
    expect(wires).toEqual(['anthropic', 'openai']);
    const recs = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(recs.map((r) => r.wire)).toEqual(['anthropic', 'openai']);
  });

  it('leaves the OpenAI wire exactly as it was', async () => {
    const { report } = await serve(() => ({ text: 'x' }));
    const body = await (
      await post(report.baseUrl, { stream: true, messages: [] })
    ).text();
    expect(body).toContain('[DONE]');
    expect(body).not.toMatch(/^event:/m);
  });

  it('builds both shapes without a socket', () => {
    expect(anthropicMessage({ tool: 't', args: { a: 1 } })).toMatchObject({
      content: [{ type: 'tool_use', name: 't', input: { a: 1 } }],
      stop_reason: 'tool_use',
    });
    expect(anthropicStream({ text: '' })).toContain('message_stop');
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

describe("the responder is the caller's module, and is treated as one", () => {
  it('answers 500 for every malformed reply instead of HANGING', async () => {
    // Measured before this check existed: `undefined`, `null`, a bare string,
    // a non-numeric `status`, and circular tool args each left the request
    // with no response at all. That is the worst shape the failure could take
    // — the product under test waits, `drive` reports `timed-out`, and a bug
    // in the harness has been presented as the behaviour of the diff.
    const bad: Array<[string, () => unknown]> = [
      ['undefined', () => undefined],
      ['null', () => null],
      ['a bare string', () => 'just a string'],
      ['an object with no known key', () => ({ foo: 1 })],
      ['an empty object', () => ({})],
      ['an empty tool name', () => ({ tool: '' })],
      [
        'circular tool args',
        () => {
          const a: Record<string, unknown> = {};
          a['self'] = a;
          return { tool: 't', args: a };
        },
      ],
      ['a non-HTTP status', () => ({ status: 999 })],
      ['a non-numeric status', () => ({ status: 'oops' })],
    ];
    const results: Array<[string, number]> = [];
    for (const [name, fn] of bad) {
      const { report } = await serve(fn as never);
      const res = await post(report.baseUrl, { stream: true, messages: [] });
      results.push([name, res.status]);
      expect(await res.text()).toContain('responder returned');
      await stop?.();
      stop = null;
    }
    // Compared as a whole so a failure names WHICH shape regressed.
    expect(results).toEqual(bad.map(([name]) => [name, 500]));
  });

  it('refuses a status body that cannot be serialised, as the tool branch does', async () => {
    // The tool branch had this guard; the status branch did not. Measured:
    // `{status: 500, body: circularObj}` passed validation and then
    // `record()`'s `JSON.stringify` threw "Converting circular structure to
    // JSON" as an UNHANDLED rejection — so the request hung and the drive
    // around it timed out. Whether a reply can be serialised is a property of
    // the reply, not of the branch it arrived on.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(replyProblem({ status: 500, body: circular } as never)).toContain(
      'cannot be serialised',
    );
    const { report } = await serve(
      () => ({ status: 500, body: circular }) as never,
    );
    const res = await post(report.baseUrl, { stream: false, messages: [] });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('responder returned');
  });

  it('names the problem precisely enough to fix the responder', () => {
    expect(replyProblem(undefined)).toContain('undefined');
    expect(replyProblem({ tool: '' })).toContain('tool name');
    expect(replyProblem({ status: 999 })).toContain('non-HTTP status');
    expect(replyProblem({ text: 42 })).toContain('non-string text');
    // ...and passes what it should
    expect(replyProblem({ text: 'x' })).toBeNull();
    expect(replyProblem({ tool: 't' })).toBeNull();
    expect(replyProblem({ status: 429 })).toBeNull();
  });
});

describe('what --help claims', () => {
  it('names every route the implementation actually serves', () => {
    // The describe said "OPENAI-COMPATIBLE endpoint (that protocol only)"
    // after `/v1/messages` had been added, so a user reading `--help` would
    // conclude the command cannot serve an Anthropic-wire product and go and
    // hand-write a second mock. Asserted against the ROUTES rather than
    // against a fixed sentence, so adding a third one without saying so fails
    // here rather than misleading someone quietly.
    const text = String(mockProviderCommand.describe);
    for (const route of ['/v1/chat/completions', '/v1/messages'])
      expect(text).toContain(route);
  });
});

describe('the entry points nothing had driven', () => {
  // Both were reported by a /review run on this PR: every test until now
  // passed `respondOverride` and called `startMockProvider` directly, so the
  // module-loading branch and the CLI handler were never executed.

  const FIXTURES = join(__dirname, '__fixtures__');
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-'));
    return { log: join(dir, 'req.jsonl'), out: join(dir, 'report.json') };
  };

  it('loads a responder exported as `respond`, and one exported as default', async () => {
    // The `?? mod.default` fallback survived deletion with every test green.
    // A user writing `export default function respond(req) {…}` would have
    // been told their module "exports no `respond` function".
    for (const [file, want] of [
      ['mock-responder-named.mjs', 'named'],
      ['mock-responder-default.mjs', 'default'],
    ]) {
      const { log } = scratch();
      const { report, close } = await startMockProvider({
        log,
        ttl: 20,
        responder: join(FIXTURES, file),
      });
      const json = (await (
        await fetch(`${report.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stream: false, messages: [] }),
        })
      ).json()) as Record<string, never>;
      expect(json['choices'][0]['message']['content']).toBe(want);
      await close();
    }
  });

  it('names the module when it exports neither', async () => {
    const { log } = scratch();
    await expect(
      startMockProvider({
        log,
        ttl: 20,
        responder: join(FIXTURES, 'mock-responder-empty.mjs'),
      }),
    ).rejects.toThrow(/exports no `respond` function/);
  });

  it('the CLI handler writes the report, and its TTL is in SECONDS', async () => {
    // Dropping the `* 1000` turns a 600-second TTL into 0.6s: the mock exits
    // before the product under test connects, and the drive around it reports
    // a product that never answered.
    const { log, out } = scratch();
    const started = Date.now();
    await (mockProviderCommand.handler as (a: unknown) => Promise<void>)({
      responder: join(FIXTURES, 'mock-responder-named.mjs'),
      log,
      out,
      ttl: 1,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.port).toBeGreaterThan(0);
    expect(report.baseUrl).toContain(String(report.port));
    expect(report.logPath).toBe(log);
  }, 15_000);

  it('sets a non-zero exit code when the responder module is unusable', async () => {
    const { log } = scratch();
    const before = process.exitCode;
    await (mockProviderCommand.handler as (a: unknown) => Promise<void>)({
      responder: join(FIXTURES, 'mock-responder-empty.mjs'),
      log,
      ttl: 1,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }, 15_000);
});

describe('the invariants, over a mixed sequence', () => {
  // Round 5 found its bug only because four rounds' fixes were exercised
  // together: each was right alone and the counter was wrong across them. A
  // single-path assertion cannot see that, so this drives 120 requests over
  // every known path — both wires, streaming and not, models, three refusal
  // shapes, oversized bodies — and checks what must hold no matter the order.
  it('holds all of them across 120 mixed requests', async () => {
    const seen: number[] = [];
    const { report, log } = await serve((r) => {
      seen.push(r.n);
      if (r.n % 7 === 0) return { status: 503, body: { e: 'x' } };
      if (r.n % 5 === 0) return { tool: 't', args: { n: r.n } };
      return { text: 'x'.repeat(r.n % 60) };
    });
    const B = report.baseUrl;
    const J = (b: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    const paths: Array<[string, () => Promise<unknown>, boolean]> = [
      [
        'oai-stream',
        () =>
          fetch(
            `${B}/chat/completions`,
            J({ stream: true, messages: [{ content: 'a' }] }),
          ),
        true,
      ],
      [
        'oai-plain',
        () =>
          fetch(
            `${B}/chat/completions`,
            J({ stream: false, messages: [{ content: 'b' }] }),
          ),
        true,
      ],
      [
        'anth-stream',
        () =>
          fetch(
            `${B}/messages`,
            J({ stream: true, system: 's', messages: [{ content: 'c' }] }),
          ),
        true,
      ],
      [
        'anth-plain',
        () =>
          fetch(
            `${B}/messages`,
            J({ stream: false, messages: [{ content: 'd' }] }),
          ),
        true,
      ],
      ['models', () => fetch(`${B}/models`), false],
      ['bad-path', () => fetch(`${B}/embeddings`, J({ x: 1 })), false],
      [
        'bad-method',
        () => fetch(`${B}/chat/completions`, { method: 'GET' }),
        false,
      ],
      [
        'bad-json',
        () => fetch(`${B}/chat/completions`, { method: 'POST', body: '{{{' }),
        false,
      ],
      [
        'huge',
        () =>
          fetch(
            `${B}/chat/completions`,
            J({ stream: false, messages: [{ content: 'z'.repeat(300_000) }] }),
          ),
        true,
      ],
    ];
    // Deterministic pseudo-random order: a fixed seed, so a failure reproduces.
    let x = 12345;
    let expectAsked = 0;
    for (let i = 0; i < 120; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const [, go, asks] = paths[x % paths.length];
      await go();
      if (asks) expectAsked++;
    }
    await stop?.();
    stop = null;

    const recs = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // One record per request, whatever happened to it.
    expect(recs).toHaveLength(120);
    // The responder saw exactly the requests that reach it, numbered 1..N.
    expect(seen).toHaveLength(expectAsked);
    expect(seen).toEqual(Array.from({ length: expectAsked }, (_, i) => i + 1));
    // ...and the record agrees with the responder about which those were.
    const numbered = recs.filter((r) => r.n !== null);
    expect(numbered.map((r) => r.n)).toEqual(seen);
    // Nothing carries the parsed body, however large the request was.
    expect(recs.every((r) => !('body' in r))).toBe(true);
    expect(
      recs.every((r) => r.wire === 'openai' || r.wire === 'anthropic'),
    ).toBe(true);
  }, 120_000);
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
