/**
 * Minimal OpenAI-compatible streaming provider used as the oracle for PR #7767.
 *
 * It records the *arrival wall-clock* of every /chat/completions request, so
 * the harness can prove (a) that no model request happens during the preload
 * window and (b) when the first request reaches the provider after a prompt.
 */
import { createServer } from 'node:http';

export async function startFakeProvider({ delayMs = 50 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    const arrivedAt = performance.now();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    requests.push({ arrivedAt, model: body.model, stream: body.stream === true });

    await new Promise((r) => setTimeout(r, delayMs));

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `chatcmpl-${requests.length}`;
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'fake-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'PONG' }, finish_reason: null }],
    });
    send({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'fake-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
