/**
 * Direct-ACP probe for PR #7767 ("preload providers after session creation").
 *
 * Speaks raw ACP (ndjson JSON-RPC) to a real `qwen --acp` child built from
 * either the control or the candidate bundle, against a fake OpenAI-compatible
 * provider. Emits one JSON sample per run.
 *
 * Modes:
 *   prompt  create 1 session, dwell, prompt, measure (default)
 *   idle    create N sessions, dwell, never prompt, measure RSS + exit cleanly
 *   broken  point the provider at an unusable base URL and prompt anyway
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeProvider } from './fake-provider.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const BUNDLE = path.resolve(arg('bundle'));
const DWELL_MS = Number(arg('dwell', '100'));
const PROVIDER_DELAY_MS = Number(arg('provider-delay', '50'));
const MODE = arg('mode', 'prompt');
const SESSIONS = Number(arg('sessions', '1'));
const PROMPT = arg('prompt', 'Reply with one short sentence. marker-7767');
const TIMEOUT_MS = Number(arg('timeout', '60000'));
const COMPILE_CACHE = arg('compile-cache', '');
const BASE_URL_OVERRIDE = arg('base-url', '');
const DEBUG_LOG = argv.includes('--debug-log');

function makeIsolatedEnv(baseUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp7767-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const qwenHome = path.join(home, '.qwen');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(qwenHome, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({ ui: { enableFollowupSuggestions: false } }),
  );
  const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
  fs.writeFileSync(
    trustedFoldersPath,
    JSON.stringify({ [fs.realpathSync(workspace)]: 'TRUST_FOLDER' }),
  );
  return {
    root,
    workspace,
    qwenHome,
    env: {
      ...process.env,
      HOME: home,
      QWEN_HOME: qwenHome,
      TMPDIR: tmp,
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      QWEN_SANDBOX: 'false',
      QWEN_CODE_INTEGRATION_TEST: 'true',
      QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
      QWEN_TELEMETRY_ENABLED: 'false',
      QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
      CI: 'true',
      TERM: 'dumb',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      NO_COLOR: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      OPENAI_API_KEY: 'fake-key',
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'fake-model',
      QWEN_MODEL: 'fake-model',
      ...(COMPILE_CACHE ? { NODE_COMPILE_CACHE: COMPILE_CACHE } : {}),
      ...(DEBUG_LOG ? { QWEN_DEBUG_LOG_FILE: '1' } : {}),
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rssKib(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    return Number(out.trim()) || null;
  } catch {
    return null;
  }
}

async function run() {
  const provider = await startFakeProvider({ delayMs: PROVIDER_DELAY_MS });
  const baseUrl =
    BASE_URL_OVERRIDE ||
    (MODE === 'broken' ? 'http://127.0.0.1:1/v1-unreachable' : provider.baseUrl);
  const { root, workspace, qwenHome, env } = makeIsolatedEnv(baseUrl);

  const t = {};
  const stderrTail = [];
  let nextId = 1;
  const pending = new Map();
  let firstChunkAt = null;
  let firstChunkText = null;
  let unhandledRejection = false;
  let preloadFailureLogged = false;

  t.spawnAt = performance.now();
  const child = spawn(process.execPath, [BUNDLE, '--acp'], {
    cwd: workspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (/unhandledRejection|UnhandledPromiseRejection|ERR_UNHANDLED/i.test(s)) {
      unhandledRejection = true;
    }
    if (/Session provider preload failed/i.test(s)) preloadFailureLogged = true;
    stderrTail.push(s);
    if (stderrTail.length > 300) stderrTail.shift();
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if ('id' in msg && !('method' in msg)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if ('error' in msg) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
        continue;
      }
      if ('id' in msg && 'method' in msg) {
        if (msg.method === 'session/request_permission') {
          const opt =
            msg.params?.options?.find((o) => String(o.optionId).includes('once')) ??
            msg.params?.options?.[0];
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: opt?.optionId } },
          });
        } else if (msg.method === 'fs/read_text_file') {
          let content = '';
          try {
            content = fs.readFileSync(msg.params.path, 'utf8');
          } catch {
            /* ignore */
          }
          send({ jsonrpc: '2.0', id: msg.id, result: { content } });
        } else if (msg.method === 'fs/write_text_file') {
          try {
            fs.writeFileSync(msg.params.path, msg.params.content ?? '');
          } catch {
            /* ignore */
          }
          send({ jsonrpc: '2.0', id: msg.id, result: null });
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
        continue;
      }
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (
          firstChunkAt === null &&
          u &&
          (u.sessionUpdate === 'agent_message_chunk' ||
            u.sessionUpdate === 'agent_thought_chunk')
        ) {
          firstChunkAt = performance.now();
          firstChunkText = u.content?.text ?? '';
        }
      }
    }
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  const sample = { ok: false, mode: MODE, dwellMs: DWELL_MS };

  try {
    t.initializeSentAt = performance.now();
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'pr7767-probe', version: '0' },
    });
    t.initializeDoneAt = performance.now();

    const sessionIds = [];
    const sessionCreateMs = [];
    let firstResult = null;
    for (let i = 0; i < SESSIONS; i++) {
      const startedAt = performance.now();
      const res = await request('session/new', {
        cwd: fs.realpathSync(workspace),
        mcpServers: [],
      });
      const readyAt = performance.now();
      if (i === 0) {
        t.sessionNewSentAt = startedAt;
        t.sessionReadyAt = readyAt;
        firstResult = res;
      }
      sessionCreateMs.push(readyAt - startedAt);
      sessionIds.push(res.sessionId);
    }

    const providerRequestsAtSessionReady = provider.requests.length;
    await sleep(DWELL_MS);
    const providerRequestsAfterDwell = provider.requests.length;

    sample.newSessionResult = firstResult;
    sample.initializeResult = init;
    sample.sessionCount = sessionIds.length;
    sample.gates = {
      providerRequestsAtSessionReady,
      providerRequestsDuringPreloadWindow:
        providerRequestsAfterDwell - providerRequestsAtSessionReady,
      unhandledRejection,
      preloadFailureLogged,
    };
    sample.metrics = {
      processToSessionReadyMs: t.sessionReadyAt - t.spawnAt,
      initializeMs: t.initializeDoneAt - t.initializeSentAt,
      sessionCreateMs: t.sessionReadyAt - t.sessionNewSentAt,
      allSessionCreateMs: sessionCreateMs,
    };

    if (MODE === 'idle') {
      sample.rssKib = rssKib(child.pid);
      sample.ok = true;
    } else {
      t.promptSentAt = performance.now();
      let promptResult = null;
      let promptError = null;
      try {
        promptResult = await request('session/prompt', {
          sessionId: sessionIds[0],
          prompt: [{ type: 'text', text: PROMPT }],
        });
      } catch (e) {
        promptError = String(e.message ?? e);
      }
      t.promptDoneAt = performance.now();
      const firstProviderRequest = provider.requests[0];
      sample.metrics.promptToProviderRequestArrivalMs = firstProviderRequest
        ? firstProviderRequest.arrivedAt - t.promptSentAt
        : null;
      sample.metrics.promptToFirstModelOutputMs =
        firstChunkAt === null ? null : firstChunkAt - t.promptSentAt;
      sample.metrics.processToFirstModelOutputMs =
        firstChunkAt === null ? null : firstChunkAt - t.spawnAt;
      sample.metrics.promptTurnMs = t.promptDoneAt - t.promptSentAt;
      sample.gates.totalProviderRequests = provider.requests.length;
      sample.gates.firstChunkText = firstChunkText;
      sample.gates.stopReason = promptResult?.stopReason ?? null;
      sample.gates.promptError = promptError;
      sample.gates.unhandledRejection = unhandledRejection;
      sample.gates.preloadFailureLogged = preloadFailureLogged;
      sample.ok = MODE === 'broken' ? true : firstChunkText === 'PONG';
    }
  } catch (err) {
    sample.error = String(err?.message ?? err);
    sample.stderrTail = stderrTail.slice(-25).join('');
  } finally {
    clearTimeout(timer);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(killTimer);
    sample.childExitCode = child.exitCode;
    sample.childSignal = child.signalCode;
    sample.gates = sample.gates ?? {};
    sample.gates.unhandledRejection = unhandledRejection;
    if (DEBUG_LOG) {
      const debugDir = path.join(qwenHome, 'debug');
      let hits = [];
      try {
        for (const f of fs.readdirSync(debugDir)) {
          const text = fs.readFileSync(path.join(debugDir, f), 'utf8');
          hits.push(
            ...text
              .split('\n')
              .filter((l) => l.includes('Session provider preload failed')),
          );
        }
      } catch {
        /* no debug dir */
      }
      sample.gates.preloadFailureLogLines = hits;
      preloadFailureLogged = preloadFailureLogged || hits.length > 0;
    }
    sample.gates.preloadFailureLogged = preloadFailureLogged;
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write('@@SAMPLE@@' + JSON.stringify(sample) + '\n');
  process.exit(sample.ok ? 0 : 1);
}

run().catch((e) => {
  process.stdout.write(
    '@@SAMPLE@@' + JSON.stringify({ ok: false, error: String(e) }) + '\n',
  );
  process.exit(1);
});
