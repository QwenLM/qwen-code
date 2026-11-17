/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared pieces of the startup benchmark: a clean environment per launch, a
// loopback model server, a real terminal, and /proc and strace readers.
// See docs/design/2026-09-25-startup-benchmark-harness.md.

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as pty from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless;

export const PROMPT_TEXT = 'Type your message';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** OpenAI-compatible stub that answers every request at once. */
export async function startModelServer() {
  const requests = new Map();
  const server = createServer((req, res) => {
    const at = performance.now();
    const match = /^\/(run-[^/]+)(\/.*)$/.exec(req.url ?? '');
    const runId = match?.[1] ?? 'unknown';
    if (!requests.has(runId)) requests.set(runId, []);
    requests.get(runId).push(at);
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let stream = false;
      try {
        stream = JSON.parse(body || '{}').stream === true;
      } catch {
        // Not JSON; answer with a plain completion.
      }
      const created = Math.floor(Date.now() / 1000);
      const choice = (delta, finish) => ({
        id: 'bench',
        object: 'chat.completion.chunk',
        created,
        model: 'bench-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify(choice({ role: 'assistant', content: 'OK' }, null))}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...choice({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'bench',
          object: 'chat.completion',
          created,
          model: 'bench-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OK' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: (runId) => `http://127.0.0.1:${port}/${runId}/v1`,
    firstRequestAt: (runId) => requests.get(runId)?.[0],
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let runCounter = 0;

// Where a run's model credentials come from: exported in the shell, in the
// settings file's `env` block (where `/auth` stores them), or in
// `~/.qwen/.env` (where the docs recommend them). The two file sources
// exercise the env-file relaunch rule.
export const CREDENTIAL_SOURCES = ['shell', 'settings', 'dotenv'];

/**
 * A fresh HOME, XDG and runtime directories, an empty git workspace, and a
 * settings file that selects OpenAI auth. The environment is reduced to what
 * a user's terminal would pass.
 */
export function makeRunEnvironment({
  root,
  modelServer,
  tmpDir,
  credentials = 'shell',
}) {
  if (!CREDENTIAL_SOURCES.includes(credentials)) {
    throw new Error(
      `credentials must be one of ${CREDENTIAL_SOURCES.join(', ')}: ${credentials}`,
    );
  }
  const runId = `run-${process.pid}-${++runCounter}`;
  const dir = path.join(root, runId);
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'workspace');
  for (const d of [
    path.join(home, '.qwen'),
    cwd,
    path.join(dir, 'xdg'),
    path.join(dir, 'runtime'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const modelEnv = {
    OPENAI_API_KEY: 'bench-key',
    OPENAI_BASE_URL: modelServer.baseUrl(runId),
  };
  fs.writeFileSync(
    path.join(home, '.qwen', 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'bench-model' },
      ...(credentials === 'settings' ? { env: modelEnv } : {}),
    }),
  );
  if (credentials === 'dotenv') {
    fs.writeFileSync(
      path.join(home, '.qwen', '.env'),
      Object.entries(modelEnv)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  }
  execFileSync('git', ['init', '-q', cwd], {
    env: { PATH: process.env.PATH, HOME: home },
  });
  const tmp = tmpDir ?? path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return {
    runId,
    dir,
    cwd,
    env: {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      HOME: home,
      QWEN_HOME: path.join(home, '.qwen'),
      QWEN_RUNTIME_DIR: path.join(dir, 'runtime'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg', 'config'),
      XDG_CACHE_HOME: path.join(dir, 'xdg', 'cache'),
      XDG_DATA_HOME: path.join(dir, 'xdg', 'data'),
      XDG_STATE_HOME: path.join(dir, 'xdg', 'state'),
      TMPDIR: tmp,
      ...(credentials === 'shell' ? modelEnv : {}),
      NO_PROXY: '127.0.0.1,localhost',
    },
  };
}

function readStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    return {
      pid,
      comm: stat.slice(stat.indexOf('(') + 1, close),
      ppid: Number(fields[1]),
      sid: Number(fields[3]),
    };
  } catch {
    return null;
  }
}

/** Processes in the session led by `rootPid`, plus its descendants. */
export function processTree(rootPid) {
  if (!fs.existsSync('/proc')) return [];
  const all = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (/^\d+$/.test(entry)) {
      const stat = readStat(Number(entry));
      if (stat) all.push(stat);
    }
  }
  const tree = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  return all.filter((p) => p.sid === rootPid || tree.has(p.pid));
}

export function rssMb(pids) {
  let kb = 0;
  for (const pid of pids) {
    try {
      kb += Number(
        /VmRSS:\s+(\d+)/.exec(
          fs.readFileSync(`/proc/${pid}/status`, 'utf8'),
        )?.[1] ?? 0,
      );
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return kb / 1024;
}

function killTree(rootPid) {
  for (const p of processTree(rootPid)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function screenText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

// A change after the prompt counts only when text already on screen is
// replaced or cleared; rows filling in are the same frame still arriving.
function replacesText(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  return a.some((line, i) => line.trim() !== '' && line !== b[i]);
}

/**
 * Launches the interactive CLI in a 120x40 terminal, types a key once the
 * prompt shows, and reports when the key became visible. The session then
 * quits with /quit so Node writes its compile cache, as it does for users.
 */
export async function runInteractive({
  command,
  args,
  cwd,
  env,
  answerQueries = true,
  observeMs = 4000,
  timeoutMs = 60_000,
}) {
  const terminal = new Terminal({
    cols: 120,
    rows: 40,
    scrollback: 2000,
    allowProposedApi: true,
  });
  const start = performance.now();
  const child = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env,
  });
  const result = {};
  let exited = null;
  let typedAt;
  let keysBefore = 0;
  let screenAtTti;
  let tail = '';
  let pending = Promise.resolve();
  let observing = true;

  if (answerQueries) terminal.onData((data) => child.write(data));
  child.onExit((e) => (exited = e));

  const evaluate = () => {
    if (!observing) return;
    const now = performance.now() - start;
    const screen = screenText(terminal);
    if (result.firstContentMs === undefined && /\S/.test(screen))
      result.firstContentMs = now;
    if (result.promptMs === undefined && screen.includes(PROMPT_TEXT)) {
      result.promptMs = now;
      keysBefore = (screen.match(/Z/g) ?? []).length;
      typedAt = now;
      child.write('Z');
    } else if (typedAt !== undefined && result.ttiMs === undefined) {
      if ((screen.match(/Z/g) ?? []).length > keysBefore) {
        result.ttiMs = now;
        result.ttiEpochMs = Date.now();
        result.rssMb = rssMb(processTree(child.pid).map((p) => p.pid));
        screenAtTti = screen;
      } else if (now - typedAt > 1500) {
        typedAt = now;
        child.write('Z');
      }
    } else if (screenAtTti !== undefined && !result.screenChanged) {
      result.screenChanged = replacesText(screenAtTti, screen);
    }
  };

  child.onData((data) => {
    tail = (tail + data).slice(-64);
    // xterm answers DA1 itself but not the background-colour query.
    if (answerQueries && tail.includes('\x1b]11;?')) {
      tail = '';
      child.write('\x1b]11;rgb:1e1e/1e1e/1e1e\x07');
    }
    pending = pending.then(
      () =>
        new Promise((resolve) =>
          terminal.write(data, () => (evaluate(), resolve())),
        ),
    );
  });

  while (
    result.ttiMs === undefined &&
    !exited &&
    performance.now() - start < timeoutMs
  ) {
    await sleep(20);
    if (typedAt !== undefined) evaluate();
  }
  if (result.ttiMs === undefined) {
    killTree(child.pid);
    terminal.dispose();
    throw new Error(
      `no typeable prompt (${exited ? `exited ${exited.exitCode}` : 'timeout'}):\n${screenText(terminal).trim().slice(-1500)}`,
    );
  }
  await sleep(observeMs);
  await pending;
  observing = false;
  result.screenChanged ??= false;

  child.write('\x7f');
  await sleep(150);
  for (const c of '/quit') {
    child.write(c);
    await sleep(25);
  }
  await sleep(250);
  child.write('\r');
  const quitStart = performance.now();
  while (!exited && performance.now() - quitStart < 10_000) await sleep(50);
  killTree(child.pid);
  terminal.dispose();
  return result;
}

/** Runs `qwen -p` against the stub and reports when its first request arrived. */
export async function runHeadless({
  command,
  args,
  cwd,
  env,
  modelServer,
  runId,
  timeoutMs = 60_000,
}) {
  const start = performance.now();
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', () => {});
  let peakRssMb = 0;
  const poll = setInterval(() => {
    peakRssMb = Math.max(
      peakRssMb,
      rssMb(processTree(child.pid).map((p) => p.pid)),
    );
  }, 20);
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve('timeout');
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ?? code);
    });
  });
  clearInterval(poll);
  const firstRequest = modelServer.firstRequestAt(runId);
  return {
    exitCode,
    stdout: stdout.trim(),
    firstRequestMs:
      firstRequest === undefined ? undefined : firstRequest - start,
    totalMs: performance.now() - start,
    peakRssMb,
  };
}

/**
 * Counts Node process images and the bytes of JavaScript they opened, from
 * `strace -f -ttt -e trace=execve,openat` output, up to `cutoffEpochMs`.
 * Each file counts once per process image.
 */
export function parseStrace(
  text,
  cutoffEpochMs = Infinity,
  fileSize = (file) => fs.statSync(file).size,
) {
  let nodeProcesses = 0;
  let jsBytes = 0;
  const opened = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) * 1000 > cutoffEpochMs) continue;
    const pid = match[1];
    const call = match[3];
    const exec = /^execve\("([^"]+)",.* = 0$/.exec(call);
    if (exec) {
      opened.set(pid, new Set());
      if (path.basename(exec[1]) === 'node') nodeProcesses++;
      continue;
    }
    const open = /^openat\([^,]+, "([^"]+\.(?:m|c)?js)", [^)]*\) = \d+$/.exec(
      call,
    );
    if (!open) continue;
    if (!opened.has(pid)) opened.set(pid, new Set());
    const files = opened.get(pid);
    if (files.has(open[1])) continue;
    files.add(open[1]);
    try {
      jsBytes += fileSize(open[1]);
    } catch {
      // A file that disappeared cannot be sized; it was a temporary one.
    }
  }
  return { nodeProcesses, jsBytes };
}

/** p50 and p75 by linear interpolation. */
export function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q) => {
    if (sorted.length === 0) return NaN;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
  };
  return { p50: at(0.5), p75: at(0.75) };
}
