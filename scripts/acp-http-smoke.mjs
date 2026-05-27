#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Black-box smoke client for the daemon's official ACP Streamable HTTP
 * transport (RFD #721), mounted at `/acp` by `qwen serve`.
 *
 * Usage:
 *   1. Start a daemon, e.g.:
 *        qwen serve --listen 127.0.0.1:8765 --token devtoken
 *      (or any port; copy the printed address)
 *   2. Run this client against it:
 *        ACP_BASE_URL=http://127.0.0.1:8765 ACP_TOKEN=devtoken \
 *          PROMPT="say hello in one word" node scripts/acp-http-smoke.mjs
 *
 * It drives: initialize → open connection stream → session/new →
 * open session stream → session/prompt, printing every session/update
 * notification and the final result. Exits non-zero on protocol failure.
 *
 * No SDK dependency — pure fetch + manual SSE parsing, so it doubles as
 * the minimal reference for what an ACP HTTP client must do.
 */

const BASE = process.env['ACP_BASE_URL'] ?? 'http://127.0.0.1:8765';
const TOKEN = process.env['ACP_TOKEN'];
const PROMPT = process.env['PROMPT'] ?? 'Say hello in exactly one word.';
const CWD = process.env['ACP_CWD'];

const authHeaders = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

function log(...a) {
  console.log(...a);
}
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function* sseFrames(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
}

async function main() {
  log(`→ daemon: ${BASE}/acp`);

  // 1. initialize
  const initRes = await fetch(`${BASE}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });
  if (initRes.status !== 200)
    die(`initialize expected 200, got ${initRes.status}`);
  const connId = initRes.headers.get('acp-connection-id');
  if (!connId) die('missing Acp-Connection-Id header');
  const initBody = await initRes.json();
  log(
    `✓ initialize: connectionId=${connId} protocolVersion=${initBody.result?.protocolVersion}`,
  );

  const connHeaders = { ...authHeaders, 'acp-connection-id': connId };

  // 2. connection-scoped stream (carries session/new reply)
  const connAbort = new AbortController();
  const connStream = await fetch(`${BASE}/acp`, {
    headers: { accept: 'text/event-stream', ...connHeaders },
    signal: connAbort.signal,
  });
  if (!connStream.ok) die(`connection stream failed: ${connStream.status}`);

  const newReply = (async () => {
    for await (const f of sseFrames(connStream, connAbort.signal)) {
      if (f.id === 2) return f;
    }
  })();

  await new Promise((r) => setTimeout(r, 100));

  // 3. session/new
  const ack = await fetch(`${BASE}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...connHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: CWD ? { cwd: CWD } : {},
    }),
  });
  if (ack.status !== 202) die(`session/new expected 202, got ${ack.status}`);
  const reply = await Promise.race([
    newReply,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), 10_000),
    ),
  ]).catch((e) => die(`session/new reply: ${e.message}`));
  const sessionId = reply.result?.sessionId;
  if (!sessionId) die('session/new returned no sessionId');
  log(`✓ session/new: sessionId=${sessionId}`);

  // 4. session-scoped stream
  const sessAbort = new AbortController();
  const sessHeaders = { ...connHeaders, 'acp-session-id': sessionId };
  const sessStream = await fetch(`${BASE}/acp`, {
    headers: { accept: 'text/event-stream', ...sessHeaders },
    signal: sessAbort.signal,
  });
  if (!sessStream.ok) die(`session stream failed: ${sessStream.status}`);

  const promptDone = (async () => {
    let updates = 0;
    for await (const f of sseFrames(sessStream, sessAbort.signal)) {
      if (f.method === 'session/update') {
        updates++;
        const u = f.params?.update;
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
          process.stdout.write(u.content.text);
        }
      } else if (f.method === 'session/request_permission') {
        // Auto-allow the first offered option so the smoke run is non-interactive.
        const optionId = f.params?.options?.[0]?.optionId;
        log(`\n  ⚙ permission requested → auto-selecting "${optionId}"`);
        await fetch(`${BASE}/acp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...connHeaders },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: f.id,
            result: { outcome: { outcome: 'selected', optionId } },
          }),
        });
      } else if (f.id === 3 && (f.result || f.error)) {
        return { updates, result: f.result, error: f.error };
      }
    }
    return { updates };
  })();

  await new Promise((r) => setTimeout(r, 100));

  // 5. session/prompt
  log(`→ prompt: ${JSON.stringify(PROMPT)}`);
  const pAck = await fetch(`${BASE}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...connHeaders },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: PROMPT }] },
    }),
  });
  if (pAck.status !== 202)
    die(`session/prompt expected 202, got ${pAck.status}`);

  const done = await Promise.race([
    promptDone,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), 60_000),
    ),
  ]).catch((e) => die(`prompt: ${e.message}`));

  log('');
  if (done.error) die(`prompt error: ${JSON.stringify(done.error)}`);
  log(
    `✓ prompt complete: ${done.updates} session/update frames, stopReason=${done.result?.stopReason}`,
  );

  // 6. teardown
  connAbort.abort();
  sessAbort.abort();
  await fetch(`${BASE}/acp`, { method: 'DELETE', headers: connHeaders }).catch(
    () => {},
  );
  log('✓ DELETE /acp — connection closed');
  log('\nALL CHECKS PASSED ✅');
  process.exit(0);
}

main().catch((e) => die(e.stack ?? String(e)));
