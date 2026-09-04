#!/usr/bin/env node
/**
 * Zero-dependency mock OpenAI-compatible chat completions server.
 * Speaks the OpenAI Chat Completions API so the CLI can be pointed at it
 * via OPENAI_BASE_URL. Supports both streaming and non-streaming responses,
 * text content, tool_calls, custom usage, and arbitrary error responses.
 *
 * Usage:
 *   1. Edit handleRequest() to define your scenario.
 *   2. Run: node mock-openai-server.js
 *   3. Point the CLI at it:
 *        OPENAI_BASE_URL=http://localhost:8765/v1 \
 *        OPENAI_API_KEY=mock \
 *        <qwen> "your prompt" --approval-mode yolo --output-format json
 *
 * Sanity check without the CLI:
 *   curl -s -X POST http://localhost:8765/v1/chat/completions \
 *     -H 'content-type: application/json' \
 *     -d '{"model":"x","messages":[{"role":"user","content":"hi"}]}'
 *
 * Env vars:
 *   PORT      (default 8765)
 *   LOG_FILE  optional — append a one-line JSON record per request
 */

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8765);
const LOG_FILE = process.env.LOG_FILE || '';

// ---------------------------------------------------------------------------
// Configure your scenario here
// ---------------------------------------------------------------------------

/**
 * Decide how to respond to a single chat completion request.
 *
 * @param {object} ctx
 * @param {object} ctx.body         - parsed JSON request body
 * @param {number} ctx.inputTokens  - chars/4 approximation over the raw body
 * @param {number} ctx.requestIndex - 0-based count of requests served so far
 * @returns one of:
 *   { kind: 'error', status: number, body: object }
 *     -> writes body as JSON with the given HTTP status
 *   { kind: 'message', content?: string, tool_calls?: [...],
 *     finish_reason?: string, usage?: {...} }
 *     -> wrapped as a chat completion (streamed or not based on body.stream)
 *
 * The default implementation echoes the last user message back as text.
 * Replace it with your scenario logic.
 */
function handleRequest({ body, inputTokens, requestIndex }) {
  const lastUser = [...(body.messages || [])]
    .reverse()
    .find((m) => m.role === 'user');
  const text =
    typeof lastUser?.content === 'string'
      ? `mock reply to: ${lastUser.content}`
      : 'mock reply';
  return { kind: 'message', content: text };
}

// ---------------------------------------------------------------------------
// Helpers — useful when writing handleRequest()
// ---------------------------------------------------------------------------

/** Approximate token count using chars/4. */
const approxTokens = (str) => Math.ceil(str.length / 4);

/** Generate a unique tool_call id. */
const callId = () => `call_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** Build a tool_call object suitable for use in `tool_calls`. */
function toolCall(name, args) {
  return {
    id: callId(),
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** True if any message in the request contains the given substring. */
function messagesContain(body, substring) {
  return JSON.stringify(body.messages || []).includes(substring);
}

/** Standard OpenAI-style error body. */
function errorBody(message, type = 'invalid_request_error', extra = {}) {
  return { error: { message, type, code: null, ...extra } };
}

// ---------------------------------------------------------------------------
// Protocol handling — no need to edit below
// ---------------------------------------------------------------------------

const log = (record) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...record });
  // eslint-disable-next-line no-console
  console.error(line);
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line + '\n');
    } catch {
      /* ignore */
    }
  }
};

function defaultUsage(inputTokens, message) {
  const completionStr =
    (message.content || '') +
    (message.tool_calls?.map((tc) => tc.function.arguments).join('') || '');
  const completionTokens = approxTokens(completionStr);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: completionTokens,
    total_tokens: inputTokens + completionTokens,
  };
}

function defaultFinishReason(message) {
  return message.finish_reason ?? (message.tool_calls ? 'tool_calls' : 'stop');
}

function writeNonStreamed(res, model, message, inputTokens) {
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: defaultFinishReason(message),
      },
    ],
    usage: message.usage ?? defaultUsage(inputTokens, message),
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeStreamed(res, model, message, inputTokens) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish_reason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send(chunk({ role: 'assistant', content: '' }));
  if (message.content) send(chunk({ content: message.content }));
  if (message.tool_calls) {
    message.tool_calls.forEach((tc, idx) => {
      send(
        chunk({
          tool_calls: [
            {
              index: idx,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        }),
      );
    });
  }
  send({
    ...chunk({}, defaultFinishReason(message)),
    usage: message.usage ?? defaultUsage(inputTokens, message),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

let requestIndex = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const inputTokens = approxTokens(raw);
    const idx = requestIndex;
    requestIndex += 1;
    log({
      kind: 'request',
      url: req.url,
      model: body.model,
      messages: (body.messages || []).length,
      inputTokens,
      stream: !!body.stream,
      requestIndex: idx,
    });

    let result;
    try {
      result = handleRequest({ body, inputTokens, requestIndex: idx });
    } catch (err) {
      log({ kind: 'handler_error', error: String(err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(String(err), 'server_error')));
      return;
    }

    if (result.kind === 'error') {
      log({ kind: 'error_response', status: result.status });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    const model = body.model || 'mock-model';
    if (body.stream) {
      writeStreamed(res, model, result, inputTokens);
    } else {
      writeNonStreamed(res, model, result, inputTokens);
    }
  });
});

server.listen(PORT, () => {
  log({ kind: 'listening', port: PORT });
});
