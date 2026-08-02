/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review mock-provider`: an OpenAI-compatible endpoint the review can
// drive the real product against, and a JSONL record of every request it saw.
//
// Measured across 94 hand-written mock servers in this repo's own verification
// sessions — the single most-rewritten artifact in that corpus, median 3.3 KB
// each. What they share is the protocol; what they differ on is the answer:
//
//   93%  SSE framing        92%  a `[DONE]` terminator
//   73%  /v1/chat/completions   69%  a usage block
//   62%  a request log on disk
//
// ...and below that the agreement stops. 43% emit `tool_calls`, but across
// those the SSE SKELETON is unanimous (41/41 carry the chunk `index`) while the
// CONTENT is not: thirteen distinct tool names, four of them appearing exactly
// once, `run_shell_command` the most common at 29%. Request classification is
// 20%, scenario switching 14%. So the split is not "how much mock to ship" but
// which half: **the protocol is a fixture, the answer is a judgement**.
//
// This command owns the fixture. The caller supplies a responder module that
// says what to reply with — text, or a tool call by name and arguments — and
// never has to get `data:` framing, chunk indices, `finish_reason` or the
// terminator right again.
//
// Two things it fixes that the corpus did by hand:
//
//   - **The port.** 67 of 94 read it from an env var, i.e. the caller picks a
//     number and hopes; only two asked the OS. This listens on 0 and reports
//     what it got, so two reviews on one machine cannot collide.
//   - **The record.** The request log is where an A/B gets its evidence: run
//     the same drive against two trees and diff the request sequences. That
//     only works if the format is the same on both sides, so it is JSONL here
//     and not "whatever this session's mock happened to print".

import type { CommandModule } from 'yargs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

/** What a responder may ask this command to send back. */
export type MockReply =
  | { text: string }
  | { tool: string; args?: unknown }
  | { status: number; body?: unknown };

/** One request, as the responder sees it and as the log records it. */
export interface MockRequest {
  method: string;
  path: string;
  /** Parsed JSON body when there was one, else null. */
  body: Record<string, unknown> | null;
  /** `messages` flattened to text, in order — what a responder branches on. */
  text: string;
  /** True when the caller asked for a stream; false for a side query. */
  stream: boolean;
  /** 1-based, per server. A responder that answers the Nth call needs this. */
  n: number;
}

export type Responder = (req: MockRequest) => MockReply | Promise<MockReply>;

export interface MockProviderReport {
  /** The port the OS gave us — never one this command or its caller chose. */
  port: number;
  baseUrl: string;
  logPath: string;
  note: string;
}

/** Flatten `messages[].content` the way every hand-written mock had to. */
export function messagesText(body: Record<string, unknown> | null): string {
  const msgs = Array.isArray(body?.['messages']) ? body['messages'] : [];
  const one = (m: unknown): string => {
    const c = (m as { content?: unknown })?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c))
      return c
        .map((p) => String((p as { text?: unknown })?.text ?? ''))
        .join('');
    return '';
  };
  return (msgs as unknown[]).map(one).join('\n');
}

const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/**
 * One SSE chunk in the shape the protocol requires.
 *
 * `index` is unanimous across every hand-written mock that emitted a tool call
 * (41 of 41) — which is what makes this a fixture rather than a choice.
 */
export function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl-qwen-review-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'qwen-review-mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** The chunk sequence for a reply — the half the caller should never write. */
export function chunksFor(reply: MockReply): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [
    chunk({ role: 'assistant', content: '' }),
  ];
  if ('tool' in reply) {
    out.push(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: `call_${reply.tool}_1`,
            type: 'function',
            function: {
              name: reply.tool,
              arguments: JSON.stringify(reply.args ?? {}),
            },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
    );
    return out;
  }
  if ('text' in reply) {
    for (const piece of reply.text.match(/[\s\S]{1,40}/g) ?? [])
      out.push(chunk({ content: piece }));
  }
  out.push(chunk({}, 'stop'));
  return out;
}

/** A non-streaming answer, for the side queries 20% of the corpus classified. */
export function completionFor(reply: MockReply): Record<string, unknown> {
  const message =
    'tool' in reply
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call_${reply.tool}_1`,
              type: 'function',
              function: {
                name: reply.tool,
                arguments: JSON.stringify(reply.args ?? {}),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'text' in reply ? reply.text : '' };
  return {
    id: 'chatcmpl-qwen-review-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'qwen-review-mock',
    choices: [
      {
        index: 0,
        message,
        finish_reason: 'tool' in reply ? 'tool_calls' : 'stop',
      },
    ],
    // 69% of the corpus carried one, and a client that reads token counts
    // behaves differently without it — an absent usage block is a behaviour
    // difference the mock introduced, not one the diff did.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export interface MockProviderArgs {
  /** Module exporting `respond(req): MockReply`. Absent → a fixed greeting. */
  responder?: string;
  /** Where the JSONL request record goes. */
  log: string;
  out?: string;
  /** Seconds to serve before shutting down on its own. */
  ttl: number;
}

const DEFAULT_REPLY: MockReply = { text: 'ok' };

export async function startMockProvider(
  args: MockProviderArgs,
  respondOverride?: Responder,
): Promise<{ report: MockProviderReport; close: () => Promise<void> }> {
  let respond: Responder = respondOverride ?? (() => DEFAULT_REPLY);
  if (!respondOverride && args.responder) {
    const mod = (await import(pathToFileURL(resolve(args.responder)).href)) as {
      respond?: Responder;
      default?: Responder;
    };
    const fn = mod.respond ?? mod.default;
    if (typeof fn !== 'function') {
      throw new Error(
        `mock-provider: ${args.responder} exports no \`respond\` function — a responder module must export \`respond(req)\` (or a default export of the same shape)`,
      );
    }
    respond = fn;
  }

  const logPath = resolve(args.log);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, '');
  let n = 0;
  const record = (entry: Record<string, unknown>) =>
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(parts).toString('utf8');
        let body: Record<string, unknown> | null = null;
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        } catch {
          body = null;
        }
        const path = req.url ?? '/';
        n += 1;
        const mreq: MockRequest = {
          method: req.method ?? 'GET',
          path,
          body,
          text: messagesText(body),
          stream: body?.['stream'] === true,
          n,
        };

        if (path.startsWith('/v1/models')) {
          record({ t: Date.now(), ...mreq, reply: 'models' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              object: 'list',
              data: [{ id: 'qwen-review-mock', object: 'model' }],
            }),
          );
          return;
        }

        let reply: MockReply;
        try {
          reply = await respond(mreq);
        } catch (err) {
          // A responder that throws is the caller's bug, and hiding it behind a
          // 200 would make the drive look like a product failure.
          reply = {
            status: 500,
            body: { error: String((err as Error).message) },
          };
        }
        record({ t: Date.now(), ...mreq, reply });

        if ('status' in reply) {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply.body ?? {}));
          return;
        }
        if (!mreq.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(completionFor(reply)));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        for (const c of chunksFor(reply)) res.write(enc(c));
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });

  // Port 0: the OS picks, and this reports what it picked. 67 of 94 mocks read
  // a port from an env var instead — a number the caller chose and hoped was
  // free, which is a collision waiting for the second review on the machine.
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    report: {
      port,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      logPath,
      note: `mock provider on port ${port}; every request is appended to ${logPath} as JSONL — diff those between two trees and the difference is evidence`,
    },
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}

export const mockProviderCommand: CommandModule = {
  command: 'mock-provider',
  describe:
    'Serve an OpenAI-compatible endpoint the review can drive the real product against, recording every request as JSONL — the protocol is provided, the answers are yours',
  builder: (yargs) =>
    yargs
      .option('responder', {
        type: 'string',
        describe:
          'Module exporting `respond(req)` returning {text} | {tool,args} | {status,body}',
      })
      .option('log', {
        type: 'string',
        demandOption: true,
        describe: 'Where to append the JSONL request record',
      })
      .option('ttl', {
        type: 'number',
        default: 600,
        describe: 'Seconds to serve before shutting down on its own',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      }),
  // `async`, and the returned promise is what keeps the process alive. A
  // fire-and-forget `void (async () => …)()` here produced a command that
  // printed nothing at all and exited: yargs returned, node found no pending
  // work it could see, and the server it had just bound went with it. Measured
  // — both streams empty, exit 0, a mock that was never reachable.
  handler: async (argv) => {
    try {
      const args = argv as unknown as MockProviderArgs;
      const { report, close } = await startMockProvider(args);
      if (args.out) {
        mkdirSync(dirname(resolve(args.out)), { recursive: true });
        writeFileSync(resolve(args.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`mock-provider: ${report.note}`);
      // A serving process needs an end, or a review that forgets to kill it
      // leaves it holding a port until the machine reboots. This await is also
      // what holds the process open while it serves.
      await new Promise<void>((done) => {
        setTimeout(done, Math.max(1, args.ttl) * 1000);
      });
      await close();
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
