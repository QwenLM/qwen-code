#!/usr/bin/env node
// Two real Codex turns, no daemon or user Host. Keeps its audit native thread.
// TSX_TSCONFIG_PATH=packages/cli/tsconfig.json node --import tsx scripts/audit/run-codex-host-session.mjs
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexHostSession } from '../../packages/cli/src/serve/workspace-agents/codex-host-session.ts';

const script = fileURLToPath(import.meta.url);
const workerMode = process.argv[2];

async function worker() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { directory, scope, prompt, cwd } = JSON.parse(input);
  const session = await codexHostSession(directory, scope);
  if (workerMode === '--read') {
    console.log(
      JSON.stringify({ workerPid: process.pid, threadId: session.threadId }),
    );
    return;
  }

  const loadedThreadId = session.threadId;
  const requests = [];
  let codex;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[0] === 'codex') {
      codex = child;
      const originalWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        const frame = JSON.parse(String(chunk));
        if (frame.id !== undefined) requests.push(frame);
        return originalWrite(chunk, ...rest);
      };
    }
    return child;
  };
  syncBuiltinESMExports();
  const { runCodexAppServer } = await import(
    '../../packages/cli/src/external-agents/codex-subagent-executor.ts'
  );
  const warnings = [];
  const stages = [];
  const started = Date.now();
  let resumeError;
  const answer = await runCodexAppServer(
    {
      command: 'codex',
      cwd,
      session,
      maxTimeMinutes: 1.5,
      onActivity(stage) {
        stages.push(stage);
      },
      onCleanupWarning(detail) {
        warnings.push(detail);
      },
    },
    prompt,
    'read-only',
    new AbortController().signal,
  ).catch((error) => {
    if (workerMode !== '--missing') throw error;
    resumeError = error.message;
  });
  assert.equal(warnings.length, 0, 'Codex process cleanup must be proven');
  assert.ok(codex && (codex.exitCode !== null || codex.signalCode !== null));
  assert.throws(() => process.kill(codex.pid, 0), { code: 'ESRCH' });
  assert.ok(
    !stages.includes('tool'),
    'recall must not read nonce from files/tools',
  );
  const turns = requests.filter((frame) => frame.method === 'turn/start');
  assert.deepEqual(
    turns.map((frame) => frame.params.input),
    workerMode === '--missing'
      ? []
      : [[{ type: 'text', text: prompt, text_elements: [] }]],
    'send exactly this round prompt, without replayed history',
  );
  const threadRequests = requests.filter((frame) =>
    ['thread/start', 'thread/resume'].includes(frame.method),
  );
  assert.equal(threadRequests.length, 1);
  assert.equal(
    threadRequests[0].method,
    loadedThreadId ? 'thread/resume' : 'thread/start',
  );
  if (loadedThreadId)
    assert.equal(threadRequests[0].params.threadId, loadedThreadId);
  const reloaded = await codexHostSession(directory, scope);
  if (workerMode === '--missing') {
    assert.match(resumeError, /Codex rejected an app-server request/);
    assert.equal(reloaded.threadId, loadedThreadId);
  }
  console.log(
    JSON.stringify({
      workerPid: process.pid,
      codexPid: codex.pid,
      codexExit: codex.exitCode ?? codex.signalCode,
      elapsedMs: Date.now() - started,
      loadedThreadId,
      threadId: reloaded.threadId,
      request: threadRequests[0].method,
      inputItems: turns.length,
      toolCalls: 0,
      answer,
      resumeError,
    }),
  );
}

async function runWorker(mode, data) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      ['--import', 'tsx', script, mode],
      {
        cwd: path.resolve(path.dirname(script), '../..'),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.resolve(
            path.dirname(script),
            '../../packages/cli/tsconfig.json',
          ),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Audit worker exited ${code}`));
      else {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(data));
  });
}

async function audit() {
  const temporary = await fs.mkdtemp(
    path.join(tmpdir(), 'codex-host-session-audit-'),
  );
  const directory = path.join(temporary, 'mappings');
  const cwd = path.join(temporary, 'workspace');
  await fs.mkdir(cwd);
  const scope = [
    'audit-server',
    'audit-workspace',
    'audit-host',
    cwd,
    'agent-a',
    'thread-a',
  ];
  const otherAgent = [...scope.slice(0, -2), 'agent-b', 'thread-a'];
  const otherThread = [...scope.slice(0, -1), 'thread-b'];
  for (const [other, id] of [
    [otherAgent, 'audit-other-agent'],
    [otherThread, 'audit-other-thread'],
  ]) {
    const mapping = await codexHostSession(directory, other);
    assert.equal(mapping.threadId, undefined);
    await mapping.save(id);
    assert.equal((await codexHostSession(directory, other)).threadId, id);
  }
  assert.equal((await codexHostSession(directory, scope)).threadId, undefined);

  const corruptDirectory = path.join(temporary, 'corrupt');
  await (await codexHostSession(corruptDirectory, scope)).save('audit-corrupt');
  const [filename] = await fs.readdir(corruptDirectory);
  const corruptFile = path.join(corruptDirectory, filename);
  for (const contents of [
    '{',
    JSON.stringify({ schemaVersion: 1, scope, threadId: '' }),
  ]) {
    await fs.writeFile(corruptFile, contents);
    await assert.rejects(codexHostSession(corruptDirectory, scope));
    assert.equal(await fs.readFile(corruptFile, 'utf8'), contents);
  }
  console.log(
    JSON.stringify({
      temporary,
      scopeIsolation: true,
      corruptMappingRejectedUnchanged: true,
    }),
  );

  const nonce = randomBytes(12).toString('hex');
  console.log('Starting real Codex round 1 (remember nonce).');
  const first = await runWorker('--round', {
    directory,
    scope,
    cwd,
    prompt: `Remember this nonce for the next turn: ${nonce}. Do not use tools, inspect or change files. Reply only with 收到.`,
  });
  assert.equal(first.answer.trim(), '收到');
  assert.ok(first.threadId);
  console.log(JSON.stringify({ round: 1, ...first }));

  const prompt =
    'What was the nonce I gave you in the previous turn? Do not use tools, inspect or change files. Reply only with the nonce.';
  assert.ok(!prompt.includes(nonce));
  console.log('Starting real Codex round 2 in a new process (recall only).');
  const second = await runWorker('--round', { directory, scope, cwd, prompt });
  assert.equal(second.answer.trim(), nonce);
  assert.equal(second.loadedThreadId, first.threadId);
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.workerPid, first.workerPid);
  assert.notEqual(second.codexPid, first.codexPid);
  console.log(JSON.stringify({ round: 2, ...second }));

  const fresh = await runWorker('--read', { directory, scope });
  assert.equal(fresh.threadId, first.threadId);
  assert.notEqual(fresh.workerPid, first.workerPid);
  assert.notEqual(fresh.workerPid, second.workerPid);
  assert.equal(
    (await codexHostSession(directory, otherAgent)).threadId,
    'audit-other-agent',
  );
  assert.equal(
    (await codexHostSession(directory, otherThread)).threadId,
    'audit-other-thread',
  );
  const missingDirectory = path.join(temporary, 'missing');
  await (
    await codexHostSession(missingDirectory, scope)
  ).save('00000000-0000-4000-8000-000000000000');
  const missing = await runWorker('--missing', {
    directory: missingDirectory,
    scope,
    cwd,
    prompt: 'Never sent.',
  });
  console.log(JSON.stringify({ failedResumePreserved: true, ...missing }));
  const report = {
    nonce,
    first,
    second,
    fresh,
    missing,
    scopeIsolation: true,
    corruptMappingRejectedUnchanged: true,
  };
  await fs.writeFile(
    path.join(temporary, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      report: path.join(temporary, 'report.json'),
      nativeThreadId: first.threadId,
    }),
  );
}

if (workerMode) await worker();
else await audit();
