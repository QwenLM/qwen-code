// End-to-end acceptance for the agent-prepared batch workflow, driving the
// real built CLI (dist/cli.js) against a fake DashScope Batch API. No real
// network, no credentials, no money.
//
// Usage: npm run build && npm run bundle, then
//   node docs/verification/batch-api/workflow-e2e.mjs ../../../dist/cli.js
// (the argument is the path to the built bundle; pass an absolute path).
// HOME is isolated inside the script so user settings cannot redirect the
// CLI at a real endpoint.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLI = process.argv[2];
if (!CLI) throw new Error('usage: node batch-e2e.mjs <path-to-cli.js>');

const state = {
  files: new Map(), // id -> content
  jobs: new Map(), // id -> job
  polls: new Map(), // job id -> poll count
  deleted: [],
  nextFile: 1,
  nextJob: 1,
  // job behavior: 'auto' completes after 2 status polls; 'stay' never does.
  behavior: 'auto',
  failItem: null, // custom_id to fail with finish_reason=length once
  failOnce: true,
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function settle(job) {
  job.status = 'completed';
  job.completed_at = Math.floor(Date.now() / 1000);
  const input = state.files.get(job.input_file_id);
  const outLines = [];
  const errLines = [];
  // The upload is stored as the raw multipart body; the JSONL payload is
  // exactly the lines that start with '{'.
  for (const raw of input.split('\n')) {
    if (!raw.trim().startsWith('{')) continue;
    const line = JSON.parse(raw);
    const customId = line.custom_id;
    const src = line.body.messages.at(-1).content;
    const docMatch = src.match(
      /<document path="[^"]*">\n([\s\S]*)\n<\/document>/,
    );
    if (state.failItem === customId) {
      outLines.push(
        JSON.stringify({
          custom_id: customId,
          response: {
            status_code: 200,
            body: {
              choices: [
                {
                  finish_reason: 'length',
                  message: { role: 'assistant', content: 'cut off' },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 2 },
            },
          },
        }),
      );
      continue;
    }
    outLines.push(
      JSON.stringify({
        custom_id: customId,
        response: {
          status_code: 200,
          body: {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: `TRANSLATED(${line.body.model}): ${docMatch ? docMatch[1] : src}`,
                },
              },
            ],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          },
        },
      }),
    );
  }
  const outId = `file-${state.nextFile++}`;
  state.files.set(outId, outLines.join('\n') + '\n');
  job.output_file_id = outId;
  if (errLines.length) {
    const errId = `file-${state.nextFile++}`;
    state.files.set(errId, errLines.join('\n') + '\n');
    job.error_file_id = errId;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && url.pathname === '/v1/files') {
    const body = await readBody(req);
    const id = `file-${state.nextFile++}`;
    // Multipart: just keep the raw body; the fake settles from input_file_id.
    state.files.set(id, body.toString('utf8'));
    return send(200, { id });
  }
  if (req.method === 'POST' && url.pathname === '/v1/batches') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const id = `batch-${state.nextJob++}`;
    // Multipart input file content arrives raw; extract the JSONL payload:
    // the fake server stored the whole multipart body under the input id.
    // Recover the inner JSONL by slicing out the file part boundary.
    const job = {
      id,
      status: 'in_progress',
      created_at: Math.floor(Date.now() / 1000),
      input_file_id: body.input_file_id,
      request_counts: { total: 0, completed: 0, failed: 0 },
    };
    state.jobs.set(id, job);
    state.polls.set(id, 0);
    return send(200, job);
  }
  const batchMatch = url.pathname.match(/^\/v1\/batches\/([^/]+)(\/cancel)?$/);
  if (batchMatch) {
    const job = state.jobs.get(batchMatch[1]);
    if (!job) return send(404, { error: 'no such batch' });
    if (req.method === 'POST' && batchMatch[2] === '/cancel') {
      job.status = 'cancelled';
      return send(200, job);
    }
    if (req.method === 'GET') {
      const polls = state.polls.get(job.id) + 1;
      state.polls.set(job.id, polls);
      if (
        state.behavior === 'auto' &&
        polls >= 2 &&
        job.status === 'in_progress'
      ) {
        settle(job);
      }
      return send(200, job);
    }
  }
  if (req.method === 'GET' && url.pathname === '/v1/batches') {
    return send(200, { data: [...state.jobs.values()], has_more: false });
  }
  const fileMatch = url.pathname.match(/^\/v1\/files\/([^/]+)(\/content)?$/);
  if (fileMatch) {
    const content = state.files.get(fileMatch[1]);
    if (
      req.method === 'GET' &&
      batchMatch === null &&
      fileMatch[2] === '/content'
    ) {
      if (content === undefined) return send(404, { error: 'no such file' });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(content);
    }
    if (req.method === 'DELETE') {
      state.deleted.push(fileMatch[1]);
      state.files.delete(fileMatch[1]);
      return send(200, { id: fileMatch[1], deleted: true });
    }
  }
  return send(404, { error: `${req.method} ${url.pathname}` });
});

const results = [];
function check(name, cond, detail = '') {
  results.push([name, Boolean(cond), detail]);
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
}

// The fake server lives in THIS process, so the event loop must stay alive
// while the CLI child runs — a sync exec would deadlock against our own
// server.
function run(cwd, env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, 'batch', ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const project = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-e2e-project-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-e2e-home-'));
// Isolate settings: the CLI merges ~/.qwen/settings.json, whose provider
// config would override the env endpoint — and point the command at a real,
// billable API. An empty HOME keeps this test hermetic.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-e2e-fakehome-'));
fs.mkdirSync(path.join(project, 'docs', 'zh'), { recursive: true });
fs.writeFileSync(path.join(project, 'docs', 'zh', 'a.md'), '# A\n\n甲文档。\n');
fs.writeFileSync(path.join(project, 'docs', 'zh', 'b.md'), '# B\n\n乙文档。\n');
fs.writeFileSync(
  path.join(project, 'plan.json'),
  JSON.stringify({
    version: 1,
    name: 'e2e-translate',
    kind: 'document-transform',
    shared: { instructions: 'Translate to English. Return only the document.' },
    items: [
      { id: 'a', source: 'docs/zh/a.md', target: 'docs/en/a.md' },
      { id: 'b', source: 'docs/zh/b.md', target: 'docs/en/b.md' },
    ],
  }),
);
const env = {
  HOME: fakeHome,
  OPENAI_API_KEY: 'fake-key',
  OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  OPENAI_MODEL: 'qwen-plus',
  QWEN_BATCH_HOME: home,
  NO_COLOR: '1',
};

try {
  // 0. check: proves the route before any preparation, bills nothing
  const checkOut = await run(project, env, ['check']);
  check(
    'check reports a ready endpoint and submits nothing',
    /ready: /.test(checkOut.stdout) && state.jobs.size === 0,
    checkOut.stdout + checkOut.stderr,
  );

  // 1. run
  const runOut = await run(project, env, ['run', 'plan.json']);
  const taskId = /task (\S+):/.exec(runOut.stdout)?.[1];
  check('run prints a task id', Boolean(taskId), taskId);
  check(
    'run prints the batch job id',
    /batch job: batch-1/.test(runOut.stdout),
  );
  check(
    'run prints the collect hint',
    runOut.stdout.includes(`collect ${taskId}`),
  );

  // 2. collect while running (no wait): nothing delivered yet
  state.behavior = 'stay';
  const early = await run(project, env, ['collect', taskId]);
  check(
    'collect reports in_progress before settle',
    /in_progress/.test(early.stdout),
  );
  check(
    'nothing delivered before settle',
    !fs.existsSync(path.join(project, 'docs', 'en', 'a.md')),
  );

  // 3. collect --wait: settles, delivers both
  state.behavior = 'auto';
  const collected = await run(project, env, [
    'collect',
    taskId,
    '--wait',
    '--timeout',
    '60',
  ]);
  check(
    'collect reports 2 delivered',
    /2 delivered/.test(collected.stdout),
    collected.stdout.trim().split('\n').pop(),
  );
  const aContent = fs.readFileSync(
    path.join(project, 'docs', 'en', 'a.md'),
    'utf8',
  );
  check(
    'target a has the transformed content',
    aContent.includes('TRANSLATED(qwen-plus): # A'),
  );
  check('usage is reported', /usage/.test(collected.stdout));
  check(
    'remote input/output deleted after collect',
    state.deleted.length >= 2,
    state.deleted.join(','),
  );

  // 4. idempotent re-collect
  const attemptDir = path.join(home, 'tasks', taskId, 'attempt-001');
  const filesBefore = fs.readdirSync(attemptDir).sort().join(',');
  const deletesBefore = state.deleted.length;
  const again = await run(project, env, ['collect', taskId]);
  check('re-collect is a no-op success', /2 delivered/.test(again.stdout));
  check(
    'no extra remote deletes on re-collect',
    state.deleted.length === deletesBefore,
    state.deleted.join(','),
  );
  check(
    'no re-download on re-collect',
    fs.readdirSync(attemptDir).sort().join(',') === filesBefore,
  );

  // 5. list
  const listOut = await run(project, env, ['list']);
  check(
    'list shows the task with progress',
    listOut.stdout.includes('2/2 delivered'),
  );

  // 6. failure + retry: new plan where item b is truncated once
  fs.writeFileSync(
    path.join(project, 'plan2.json'),
    JSON.stringify({
      version: 1,
      name: 'e2e-translate-2',
      kind: 'document-transform',
      shared: {
        instructions: 'Translate to English. Return only the document.',
      },
      items: [
        { id: 'a', source: 'docs/zh/a.md', target: 'docs/en/a2.md' },
        { id: 'b', source: 'docs/zh/b.md', target: 'docs/en/b2.md' },
      ],
    }),
  );
  const run2 = await run(project, env, ['run', 'plan2.json']);
  const taskId2 = /task (\S+):/.exec(run2.stdout)?.[1];
  state.failItem = 'b#1';
  state.behavior = 'auto';
  const collect2 = await run(project, env, [
    'collect',
    taskId2,
    '--wait',
    '--timeout',
    '60',
  ]);
  check(
    'truncated item is failed, not delivered',
    /1 delivered, 0 held, 1 failed/.test(collect2.stdout),
    collect2.stdout,
  );
  check('failure reason names truncation', /truncated/.test(collect2.stdout));
  check(
    'failed target was not written',
    !fs.existsSync(path.join(project, 'docs', 'en', 'b2.md')),
  );

  // 7. a truncated item is not resent with the same limit (it would fail
  // and bill again); raising the limit resubmits only that item
  state.failItem = null;
  const skipOut = await run(project, env, ['retry', taskId2]);
  check(
    'retry skips a truncated item without a larger limit',
    /skipping 1 truncated item/.test(skipOut.stdout) &&
      !/batch job:/.test(skipOut.stdout),
    skipOut.stdout,
  );
  const retryOut = await run(project, env, [
    'retry',
    taskId2,
    '--max-output-tokens',
    '8192',
  ]);
  check(
    'retry prints a new batch job',
    /batch job: batch-3/.test(retryOut.stdout),
    retryOut.stdout,
  );
  const collect3 = await run(project, env, [
    'collect',
    taskId2,
    '--wait',
    '--timeout',
    '60',
  ]);
  check(
    'retry delivers the failed item',
    /2 delivered, 0 held, 0 failed/.test(collect3.stdout),
    collect3.stdout,
  );
  check(
    'b2 written after retry',
    fs
      .readFileSync(path.join(project, 'docs', 'en', 'b2.md'), 'utf8')
      .includes('TRANSLATED'),
  );

  // 8. target conflict: b3 exists with other content -> held -> resolve -> delivered
  fs.writeFileSync(
    path.join(project, 'plan3.json'),
    JSON.stringify({
      version: 1,
      name: 'e2e-translate-3',
      kind: 'document-transform',
      shared: {
        instructions: 'Translate to English. Return only the document.',
      },
      items: [{ id: 'b', source: 'docs/zh/b.md', target: 'docs/en/b3.md' }],
    }),
  );
  fs.writeFileSync(path.join(project, 'docs', 'en', 'b3.md'), 'user edits');
  const run3 = await run(project, env, ['run', 'plan3.json']);
  const taskId3 = /task (\S+):/.exec(run3.stdout)?.[1];
  const collect4 = await run(project, env, [
    'collect',
    taskId3,
    '--wait',
    '--timeout',
    '60',
  ]);
  check('conflicting target is held', /1 held/.test(collect4.stdout));
  check(
    'held target keeps user content',
    fs.readFileSync(path.join(project, 'docs', 'en', 'b3.md'), 'utf8') ===
      'user edits',
  );
  fs.rmSync(path.join(project, 'docs', 'en', 'b3.md'));
  const collect5 = await run(project, env, ['collect', taskId3]);
  check(
    'held item delivers after conflict resolved',
    /1 delivered, 0 held/.test(collect5.stdout),
  );

  // 9. cancel: fresh task, cancel before settle
  fs.writeFileSync(
    path.join(project, 'plan4.json'),
    JSON.stringify({
      version: 1,
      name: 'e2e-translate-4',
      kind: 'document-transform',
      shared: {
        instructions: 'Translate to English. Return only the document.',
      },
      items: [{ id: 'a', source: 'docs/zh/a.md', target: 'docs/en/a4.md' }],
    }),
  );
  const run4 = await run(project, env, ['run', 'plan4.json']);
  const taskId4 = /task (\S+):/.exec(run4.stdout)?.[1];
  state.behavior = 'stay';
  const cancelOut = await run(project, env, ['cancel', taskId4]);
  check(
    'cancel warns about billed partials',
    /still billed/.test(cancelOut.stdout),
  );

  // 10. clean: refuses while the cancelled batch is uncollected; a collected
  // task goes without touching the provider or the delivered files
  const cleanRefused = await run(project, env, ['clean', taskId4]);
  check(
    'clean refuses a task whose batch is not collected',
    cleanRefused.code !== 0 && /--force/.test(cleanRefused.stderr),
    cleanRefused.stderr,
  );
  const cleanOut = await run(project, env, ['clean', taskId]);
  check(
    'clean removes a collected task and keeps its delivered files',
    /removed local record/.test(cleanOut.stdout) &&
      !fs.existsSync(path.join(home, 'tasks', taskId)) &&
      fs.existsSync(path.join(project, 'docs', 'en', 'a.md')),
    cleanOut.stdout + cleanOut.stderr,
  );

  const failed = results.filter(([, ok]) => !ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exitCode = failed.length ? 1 : 0;
} finally {
  server.close();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
