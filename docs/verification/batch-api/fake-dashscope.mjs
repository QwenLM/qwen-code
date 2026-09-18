/**
 * Fake DashScope/OpenAI-compatible server for L1 verification of the
 * `qwen batch` command and `--batch` mode. Records every request so a run can
 * be asserted on the call sequence (e.g. how many batches were created).
 *
 * Scenarios (env SCENARIO):
 *   happy  - one batch, completes on first poll, plain text output
 *   tools  - first batch returns tool_calls, second returns text
 *   failed - every batch settles as `failed`
 *   slow   - batch stays in_progress for SLOW_SECONDS, then completes
 *   stuck  - batch never completes (for abort/cancel tests)
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 8899);
const SCENARIO = process.env.SCENARIO || 'happy';
const SLOW_SECONDS = Number(process.env.SLOW_SECONDS || 600);
const LOG = process.env.LOG || '/tmp/fake-dashscope.log';
const MODEL = process.env.FAKE_MODEL || 'qwen-plus';

fs.writeFileSync(LOG, '');
let fileSeq = 0;
let batchSeq = 0;
const files = new Map(); // id -> {content, purpose, name}
const batches = new Map(); // id -> job

const now = () => Math.floor(Date.now() / 1000);
const log = (entry) =>
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n');

/** Pull the JSONL request lines out of a multipart upload body. */
function extractJsonl(raw) {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.includes('"custom_id"'));
}

function completionBody(kind, id) {
  const base = {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: now(),
    model: MODEL,
    usage: {
      prompt_tokens: 120,
      completion_tokens: 8,
      total_tokens: 128,
      prompt_tokens_details: { cached_tokens: 64 },
    },
  };
  if (kind === 'tool_call') {
    return {
      ...base,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_batch_1',
                type: 'function',
                function: {
                  name: 'list_directory',
                  arguments: JSON.stringify({ path: '.' }),
                },
              },
            ],
          },
        },
      ],
    };
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'BATCH_OK' },
      },
    ],
  };
}

/** Advance a job's status for the current scenario and return it. */
function pollJob(job) {
  const elapsed = now() - job.created_at;
  if (SCENARIO === 'stuck') {
    job.status = 'in_progress';
    job.in_progress_at ??= now();
    return job;
  }
  if (SCENARIO === 'slow' && elapsed < SLOW_SECONDS) {
    job.status = 'in_progress';
    job.in_progress_at ??= now();
    return job;
  }
  if (SCENARIO === 'failed') {
    job.status = 'failed';
    job.completed_at = now();
    job.request_counts = { total: 1, completed: 0, failed: 1 };
    const errId = `file-err-${++fileSeq}`;
    files.set(errId, {
      content:
        JSON.stringify({
          custom_id: 'turn',
          error: { message: 'fake: model unavailable in batch' },
        }) + '\n',
    });
    job.error_file_id = errId;
    return job;
  }
  // happy / tools
  job.status = 'completed';
  job.in_progress_at ??= job.created_at + 1;
  job.completed_at = now();
  const lines = job.lines.map((line, i) => {
    const kind =
      SCENARIO === 'tools' && job.seq === 1 && i === 0 ? 'tool_call' : 'text';
    return JSON.stringify({
      custom_id: JSON.parse(line).custom_id ?? String(i),
      response: {
        status_code: 200,
        body: completionBody(kind, `${job.id}-${i}`),
      },
    });
  });
  const outId = `file-out-${++fileSeq}`;
  files.set(outId, { content: lines.join('\n') + '\n' });
  job.output_file_id = outId;
  job.request_counts = {
    total: job.lines.length,
    completed: job.lines.length,
    failed: 0,
  };
  return job;
}

function send(res, code, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname.replace(/^\/v1/, '');
    log({ method: req.method, path: p, bytes: raw.length });

    // --- files ---
    if (p === '/files' && req.method === 'POST') {
      const id = `file-in-${++fileSeq}`;
      const lines = extractJsonl(raw);
      files.set(id, { content: lines.join('\n'), lines });
      log({ event: 'upload', id, lineCount: lines.length, lines });
      return send(res, 200, {
        id,
        object: 'file',
        purpose: 'batch',
        bytes: raw.length,
      });
    }
    let m = p.match(/^\/files\/([^/]+)\/content$/);
    if (m && req.method === 'GET') {
      const f = files.get(m[1]);
      if (!f) return send(res, 404, { error: { message: 'no such file' } });
      res.writeHead(200, { 'Content-Type': 'application/jsonl' });
      return res.end(f.content);
    }
    m = p.match(/^\/files\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      files.delete(m[1]);
      log({ event: 'file_deleted', id: m[1] });
      return send(res, 200, { id: m[1], object: 'file', deleted: true });
    }

    // --- batches ---
    if (p === '/batches' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      const id = `batch_fake_${++batchSeq}`;
      const input = files.get(body.input_file_id);
      const job = {
        id,
        seq: batchSeq,
        object: 'batch',
        status: 'validating',
        endpoint: body.endpoint,
        completion_window: body.completion_window,
        input_file_id: body.input_file_id,
        created_at: now(),
        expires_at: now() + 86400,
        request_counts: {
          total: input?.lines?.length ?? 1,
          completed: 0,
          failed: 0,
        },
        lines: input?.lines ?? ['{"custom_id":"turn"}'],
      };
      batches.set(id, job);
      log({
        event: 'batch_created',
        id,
        endpoint: body.endpoint,
        window: body.completion_window,
      });
      return send(res, 200, job);
    }
    m = p.match(/^\/batches\/([^/]+)\/cancel$/);
    if (m && req.method === 'POST') {
      const job = batches.get(m[1]);
      if (!job) return send(res, 404, { error: { message: 'no such batch' } });
      job.status = 'cancelled';
      job.completed_at = now();
      log({ event: 'batch_cancelled', id: job.id });
      return send(res, 200, job);
    }
    m = p.match(/^\/batches\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const job = batches.get(m[1]);
      if (!job) return send(res, 404, { error: { message: 'no such batch' } });
      return send(res, 200, pollJob(job));
    }

    // --- realtime chat (side calls) ---
    if (p === '/chat/completions' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}');
      log({ event: 'realtime_chat', stream: !!body.stream, model: body.model });
      const completion = completionBody('text', `rt-${Date.now()}`);
      if (!body.stream) return send(res, 200, completion);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = {
        id: completion.id,
        object: 'chat.completion.chunk',
        created: completion.created,
        model: completion.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'REALTIME_OK' },
            finish_reason: 'stop',
          },
        ],
        usage: completion.usage,
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    log({ event: 'unhandled', method: req.method, path: p });
    send(res, 404, {
      error: { message: `fake server: no route ${req.method} ${p}` },
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `fake-dashscope listening on ${PORT} scenario=${SCENARIO} log=${LOG}\n`,
  );
});
