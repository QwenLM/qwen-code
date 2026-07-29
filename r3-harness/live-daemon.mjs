/**
 * PR #7914 R3 — live `qwen serve` E2E at head a96c93bdc2.
 *
 * Real daemon, real write_file tool, real SessionArtifactStore, fake model.
 * The model writes a file and ENDS THE TURN — it never calls record_artifact.
 * Whatever lands in GET /session/:id/artifacts got there from the write alone.
 *
 * Scenarios:
 *   A  reports/quarterly.html            -> expect 1 artifact  (the PR's goal)
 *   B  reports/chart onerror=alert(1).html -> expect 0 artifacts (guard rejects)
 *   C  src/index.ts                       -> expect 0 artifacts (not artifact-like)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TREE = path.resolve(import.meta.dirname, '..');
const MODEL_PORT = 8731;
const SERVE_PORT = 8732;

// realpathSync: the daemon binds the realpath of --workspace. Handing the model
// an unresolved /var/... path puts every write "outside the workspace" and both
// arms emit nothing — which looks exactly like "the fix doesn't work".
const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-live-ws-')));
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pr7914-live-home-')));

mkdirSync(path.join(home, '.qwen'), { recursive: true });
writeFileSync(
  path.join(home, '.qwen', 'settings.json'),
  JSON.stringify(
    {
      security: { auth: { selectedType: 'openai', apiKey: 'fake-key' } },
      model: { name: 'fake-model' },
      privacy: { usageStatisticsEnabled: false },
    },
    null,
    2,
  ),
);

const SCENARIOS = [
  { id: 'A', rel: 'reports/quarterly.html', expect: 1, why: 'ordinary HTML report' },
  { id: 'B', rel: 'reports/chart onerror=alert(1).html', expect: 0, why: 'guard rejects unsafe title' },
  { id: 'C', rel: 'src/index.ts', expect: 0, why: 'not an artifact-like extension' },
];

// ---------- fake OpenAI-compatible model ----------
let modelCalls = 0;
const modelServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    modelCalls++;
    const parsed = JSON.parse(body || '{}');
    const messages = parsed.messages ?? [];
    // The daemon may reuse one session across scenarios, so "is there a
    // role:'tool' message" is true for every turn after the first and the
    // later scenarios would silently never fire. Branch on THIS scenario's
    // own call id instead.
    const userText = JSON.stringify(messages.filter((m) => m.role === 'user'));
    // Last marker wins: the newest user turn is the one being answered.
    let scenario;
    for (const s of SCENARIOS) {
      const at = userText.lastIndexOf(`SCENARIO=${s.id}`);
      if (at >= 0 && (scenario === undefined || at > scenario.at)) {
        scenario = { ...s, at };
      }
    }
    const transcript = JSON.stringify(messages);
    const alreadyWrote = scenario
      ? transcript.includes(`call_${scenario.id}`)
      : true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (delta, finish) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        })}\n\n`,
      );

    if (!alreadyWrote && scenario) {
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${scenario.id}`,
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({
                file_path: path.join(workspace, scenario.rel),
                content: '<!doctype html><html><body><h1>Q3 report</h1></body></html>',
              }),
            },
          },
        ],
      });
      send({}, 'tool_calls');
    } else {
      // The turn ENDS here. No record_artifact call, ever.
      send({ role: 'assistant', content: 'Done. The report is written.' });
      send({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

// ---------- helpers ----------
const api = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${SERVE_PORT}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
};

const waitFor = async (fn, label, timeoutMs = 90_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${label}`);
};

// ---------- run ----------
const results = [];
await new Promise((r) => modelServer.listen(MODEL_PORT, '127.0.0.1', r));
console.log(`fake model on :${MODEL_PORT}`);

const serve = spawn(
  path.join(TREE, 'node_modules/.bin/tsx'),
  [path.join(TREE, 'packages/cli/index.ts'), 'serve', '--port', String(SERVE_PORT), '--workspace', workspace],
  {
    cwd: TREE,
    env: {
      ...process.env,
      HOME: home,
      QWEN_HOME: path.join(home, '.qwen'),
      OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`,
      OPENAI_API_KEY: 'fake-key',
      OPENAI_MODEL: 'fake-model',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serveLog = '';
serve.stdout.on('data', (d) => (serveLog += d));
serve.stderr.on('data', (d) => (serveLog += d));

try {
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/health`);
      return r.ok;
    } catch {
      return false;
    }
  }, 'daemon /health');
  console.log('daemon up\n');

  for (const s of SCENARIOS) {
    const created = await api('POST', '/session', {
      workspace,
      approvalMode: 'yolo',
    });
    const sessionId = created.json.sessionId ?? created.json.id;
    if (!sessionId) {
      console.log(`${s.id}: could not create session -> ${JSON.stringify(created.json).slice(0, 300)}`);
      continue;
    }

    // Sessions may be reused across scenarios, so count the DELTA this
    // scenario added rather than the absolute list length.
    const before = await api('GET', `/session/${sessionId}/artifacts`);
    const beforeKeys = new Set(
      (before.json.artifacts ?? []).map((a) => a.workspacePath ?? a.id),
    );

    await api('POST', `/session/${sessionId}/prompt`, {
      prompt: [{ type: 'text', text: `SCENARIO=${s.id} Write the report file.` }],
    });

    const abs = path.join(workspace, s.rel);
    await waitFor(async () => existsSync(abs), `${s.id}: file on disk`).catch(() => {});

    // Let the turn settle so any artifact publish has landed.
    await new Promise((r) => setTimeout(r, 3000));

    const arts = await api('GET', `/session/${sessionId}/artifacts`);
    const list = (arts.json.artifacts ?? []).filter(
      (a) => !beforeKeys.has(a.workspacePath ?? a.id),
    );
    results.push({
      id: s.id,
      rel: s.rel,
      why: s.why,
      sessionId,
      fileOnDisk: existsSync(abs),
      expect: s.expect,
      got: list.length,
      artifacts: list.map((a) => ({
        title: a.title,
        kind: a.kind,
        storage: a.storage,
        workspacePath: a.workspacePath,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        toolName: a.toolName,
      })),
    });
  }
} finally {
  serve.kill('SIGTERM');
  modelServer.close();
}

console.log('=== LIVE DAEMON RESULTS (head a96c93bdc2) ===\n');
for (const r of results) {
  const ok = r.got === r.expect ? 'PASS' : 'FAIL';
  console.log(`${r.id}  ${r.why}`);
  console.log(`    path         ${r.rel}`);
  console.log(`    file written ${r.fileOnDisk}   session ${String(r.sessionId).slice(0, 12)}`);
  console.log(`    NEW artifacts this turn: expected=${r.expect} got=${r.got}  [${ok}]`);
  for (const a of r.artifacts) console.log(`      ${JSON.stringify(a)}`);
  console.log('');
}
console.log(`model HTTP calls: ${modelCalls}`);
writeFileSync(
  path.join(TREE, 'harness', 'live-daemon-results.json'),
  JSON.stringify({ head: 'a96c93bdc2', workspace, results }, null, 2),
);
if (!results.length) console.log('SERVE LOG:\n' + serveLog.slice(-4000));
