#!/usr/bin/env node
// Two real Codex turns, no daemon or user Host. Keeps its audit native thread.
// TSX_TSCONFIG_PATH=packages/cli/tsconfig.json node --import tsx scripts/audit/run-codex-host-session.mjs
// Add --warm to verify two turns in one App Server process instead of cold resume.
// --live-followup uses the online developer Host at 4171 and UI at 5174; keeps one audit conversation.
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
  const { directory, scope, prompt, nextPrompt, cwd } = JSON.parse(input);
  const session = await codexHostSession(directory, scope);
  if (workerMode === '--read') {
    console.log(
      JSON.stringify({ workerPid: process.pid, threadId: session.threadId }),
    );
    return;
  }

  const loadedThreadId = session.threadId;
  const requests = [];
  const spawned = [];
  let codex;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[0] === 'codex') {
      codex = child;
      spawned.push(child);
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
  if (workerMode === '--warm-worker') {
    const rounds = [];
    const callbacks = [[], []];
    let firstCallbacks;
    for (const [index, text] of [prompt, nextPrompt].entries()) {
      const started = Date.now();
      const currentSession = await codexHostSession(directory, scope);
      const answer = await runCodexAppServer(
        {
          command: 'codex',
          cwd,
          session: currentSession,
          keepAlive: index === 0,
          maxTimeMinutes: 1.5,
          onMessage(itemId, output) {
            callbacks[index].push({ itemId, text: output });
          },
          onActivity(stage) {
            stages.push(stage);
          },
          onCleanupWarning(detail) {
            warnings.push(detail);
          },
        },
        text,
        'read-only',
        new AbortController().signal,
      );
      assert.ok(callbacks[index].length > 0);
      assert.equal(callbacks[index].at(-1).text, answer);
      if (index === 0) {
        assert.equal(answer.trim(), '收到');
        assert.equal(codex.exitCode, null);
        assert.equal(codex.signalCode, null);
        process.kill(codex.pid, 0);
        firstCallbacks = JSON.stringify(callbacks[0]);
      }
      rounds.push({
        codexPid: codex.pid,
        threadId: currentSession.threadId,
        elapsedMs: Date.now() - started,
        answer,
      });
      console.error(JSON.stringify({ warmRound: index + 1, ...rounds[index] }));
    }
    assert.equal(spawned.length, 1);
    assert.equal(rounds[0].threadId, rounds[1].threadId);
    assert.equal(rounds[0].codexPid, rounds[1].codexPid);
    assert.equal(warnings.length, 0);
    assert.ok(!stages.includes('tool'));
    assert.ok(codex.exitCode !== null || codex.signalCode !== null);
    assert.throws(() => process.kill(codex.pid, 0), { code: 'ESRCH' });
    assert.equal(
      JSON.stringify(callbacks[0]),
      firstCallbacks,
      'second turn must not call the first handler',
    );
    const firstIds = new Set(callbacks[0].map(({ itemId }) => itemId));
    assert.ok(
      callbacks[1].every(
        ({ itemId, text }) => !firstIds.has(itemId) && !text.includes('收到'),
      ),
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ['initialize', 'thread/start', 'turn/start', 'turn/start'],
    );
    const turns = requests.filter(({ method }) => method === 'turn/start');
    assert.deepEqual(
      turns.map(({ params }) => params.input),
      [prompt, nextPrompt].map((text) => [
        { type: 'text', text, text_elements: [] },
      ]),
    );
    assert.ok(
      turns.every(({ params }) => params.threadId === rounds[0].threadId),
    );
    console.log(
      JSON.stringify({
        workerPid: process.pid,
        rounds,
        callbackCounts: callbacks.map((events) => events.length),
        callbacksIsolated: true,
        spawns: spawned.length,
        requests: requests.map(({ method }) => method),
        codexExit: codex.exitCode ?? codex.signalCode,
      }),
    );
    return;
  }
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
    child.once('close', (code) => {
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
  const firstPrompt = `Remember this nonce for the next turn: ${nonce}. Do not use tools, inspect or change files. Reply only with 收到.`;
  const prompt =
    'What was the nonce I gave you in the previous turn? Do not use tools, inspect or change files. Reply only with the nonce.';
  assert.ok(!prompt.includes(nonce));
  if (workerMode === '--warm') {
    console.log('Starting two real Codex turns in one warm process.');
    const warm = await runWorker('--warm-worker', {
      directory,
      scope,
      cwd,
      prompt: firstPrompt,
      nextPrompt: prompt,
    });
    assert.equal(warm.rounds[1].answer.trim(), nonce);
    const fresh = await runWorker('--read', { directory, scope });
    assert.equal(fresh.threadId, warm.rounds[0].threadId);
    const report = path.join(temporary, 'warm-report.json');
    await fs.writeFile(report, JSON.stringify({ nonce, warm, fresh }, null, 2));
    console.log(
      JSON.stringify({ passed: true, mode: 'warm', report, ...warm }),
    );
    return;
  }
  console.log('Starting real Codex round 1 (remember nonce).');
  const first = await runWorker('--round', {
    directory,
    scope,
    cwd,
    prompt: firstPrompt,
  });
  assert.equal(first.answer.trim(), '收到');
  assert.ok(first.threadId);
  console.log(JSON.stringify({ round: 1, ...first }));

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

async function liveFollowup() {
  const { chromium, expect } = await import('@playwright/test');
  const { Storage } = await import('../../packages/core/src/config/storage.ts');
  const cwd = path.resolve(path.dirname(script), '../..');
  const server = 'http://127.0.0.1:4171';
  const prefix = `${server}/workspaces/${encodeURIComponent(cwd)}/agent`;
  const request = async (route, data) => {
    const response = await fetch(`${prefix}${route}`, {
      ...(data
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(data),
          }
        : {}),
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return response.json();
  };
  const { agents } = await request('/agents');
  const agent = agents.find((candidate) => candidate.name === '开发工程师');
  assert.ok(agent?.enabled && agent.runtime?.status === 'online');
  const artifacts = await fs.mkdtemp(
    path.join(tmpdir(), 'codex-host-live-followup-'),
  );
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const title = `E2E Host follow-up ${new Date().toISOString()}`;
  const marker = `FOLLOWUP_${randomBytes(8).toString('hex')}`;
  const observations = [];
  const pids = new Map();
  const nativeIds = new Map();
  let threadId;
  let secondMessageId;
  let detail;
  try {
    await page.goto('http://127.0.0.1:5174/?language=en', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await expect(
      page.getByRole('button', { name: 'New task', exact: true }),
    ).toBeVisible({ timeout: 30000 });
    ({ id: threadId } = await request('/threads', { title, body: '' }));
    console.log(
      JSON.stringify({ createdThreadId: threadId, title, artifacts }),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page
      .getByRole('button', { name: title, exact: true })
      .click({ timeout: 30000 });
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    const transcript = page.locator('[data-web-shell-message-list]:visible');
    const replies = transcript
      .locator('[data-web-shell-message-row]')
      .filter({ has: page.locator('strong').filter({ hasText: agent.name }) });
    const started = Date.now();
    await request(`/threads/${threadId}/posts`, {
      text: `@${agent.name} 不要使用工具、查阅或改动文件。请用约500个英文单词，分四个普通段落解释水循环。本条请完整回答，供后续继续讨论。`,
    });
    const scope = [
      server,
      agent.runtime.workspaceId,
      agent.runtime.id,
      cwd,
      agent.id,
      threadId,
    ];
    const mappingDir = path.join(
      Storage.getGlobalQwenDir(),
      'agent-hosts',
      'codex-sessions',
    );
    let firstRunId;
    let sentSecond = false;
    let capturedBody = false;
    while (Date.now() - started < 150000) {
      detail = await request(`/threads/${threadId}`);
      firstRunId ??= detail.runs[0]?.id;
      for (const run of detail.runs) {
        assert.ok(
          !['failed', 'cancelled'].includes(run.status),
          `Run ${run.id} ${run.status}`,
        );
        const pid = run.progress?.detail?.match(/Codex PID (\d+)/)?.[1];
        if (pid) pids.set(run.id, Number(pid));
        if (run.status === 'running') {
          const mapping = await codexHostSession(mappingDir, scope);
          if (mapping.threadId) nativeIds.set(run.id, mapping.threadId);
        }
        const sample = {
          runId: run.id,
          status: run.status,
          stage: run.progress?.stage,
          sequence: run.progress?.sequence,
          bodyLength: run.progress?.outputText?.length ?? 0,
          pid: pids.get(run.id),
          nativeId: nativeIds.get(run.id),
        };
        const previous = observations.findLast(
          (entry) => entry.runId === run.id,
        );
        if (
          JSON.stringify(sample) !==
          JSON.stringify(
            previous &&
              Object.fromEntries(
                Object.entries(previous).filter(([key]) => key !== 'elapsedMs'),
              ),
          )
        ) {
          observations.push({ elapsedMs: Date.now() - started, ...sample });
          if (
            !previous ||
            previous.status !== sample.status ||
            (!previous.pid && sample.pid)
          )
            console.log(JSON.stringify(observations.at(-1)));
        }
        if (
          !sentSecond &&
          run.id === firstRunId &&
          run.status === 'running' &&
          pids.has(run.id)
        ) {
          sentSecond = true;
          await request(`/threads/${threadId}/posts`, {
            text: `@${agent.name} 这是运行中的独立后续消息。本轮只回复标记 ${marker}，不要重复前一条解释，不要使用工具。`,
          });
          const posted = await request(`/threads/${threadId}`);
          const message = posted.posts
            .filter((post) => post.authorKind === 'human')
            .at(-1);
          secondMessageId = message.id;
          assert.ok(
            message.outcomes.some(
              (outcome) =>
                outcome.kind === 'coalesce' &&
                outcome.into === 'running' &&
                outcome.runId === firstRunId,
            ),
          );
          console.log(
            JSON.stringify({
              secondMessageId,
              coalescedIntoRunning: firstRunId,
              elapsedMs: Date.now() - started,
            }),
          );
        }
        if (
          sentSecond &&
          !capturedBody &&
          run.status === 'running' &&
          sample.bodyLength > 100
        ) {
          await expect(replies).toContainText(
            run.progress.outputText.slice(0, 60),
            { timeout: 10000 },
          );
          await page.screenshot({
            path: path.join(artifacts, 'running-body.png'),
          });
          capturedBody = true;
        }
      }
      if (
        detail.runs.length === 2 &&
        detail.runs.every((run) => run.status === 'completed')
      )
        break;
      assert.ok(
        sentSecond || detail.runs.every((run) => run.status !== 'completed'),
        'first run completed before a PID was observed',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(detail.runs.length, 2);
    assert.ok(detail.runs.every((run) => run.status === 'completed'));
    const successor = detail.runs.find((run) => run.id !== firstRunId);
    const second = detail.posts.find((post) => post.id === secondMessageId);
    assert.ok(
      second.outcomes.some(
        (outcome) =>
          outcome.kind === 'coalesce' &&
          outcome.into === 'queued' &&
          outcome.runId === successor.id,
      ),
    );
    const firstReplies = detail.posts.filter(
      (post) => post.sourceRunId === firstRunId,
    );
    const secondReplies = detail.posts.filter(
      (post) => post.sourceRunId === successor.id,
    );
    assert.equal(firstReplies.length, 1);
    assert.ok(firstReplies[0].text.length > 100);
    assert.equal(secondReplies.length, 1);
    assert.equal(secondReplies[0].text.trim(), marker);
    assert.equal(nativeIds.size, 2);
    assert.equal(new Set(nativeIds.values()).size, 1);
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText(marker);
    await page.screenshot({ path: path.join(artifacts, 'two-replies.png') });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText(marker);
    await page.screenshot({
      path: path.join(artifacts, 'two-replies-refreshed.png'),
    });
    console.log(
      JSON.stringify({
        passed: true,
        mode: 'live-followup',
        threadId,
        secondMessageId,
        marker,
        pids: [...pids],
        pidCheck:
          pids.size === 2 && new Set(pids.values()).size === 1
            ? 'same_pid_observed'
            : 'not_proven_by_live_snapshots; use --warm',
        nativeIds: [...nativeIds],
        formalReplies: 2,
        browserReplies: 2,
        artifacts,
      }),
    );
  } catch (error) {
    await page
      .screenshot({ path: path.join(artifacts, 'failure.png') })
      .catch(() => {});
    console.error(
      JSON.stringify({
        failed: true,
        threadId,
        artifacts,
        error: error.message,
      }),
    );
    throw error;
  } finally {
    await fs.writeFile(
      path.join(artifacts, 'report.json'),
      JSON.stringify(
        {
          threadId,
          secondMessageId,
          marker,
          pids: [...pids],
          pidCheck:
            pids.size === 2 && new Set(pids.values()).size === 1
              ? 'same_pid_observed'
              : 'not_proven_by_live_snapshots; use --warm',
          nativeIds: [...nativeIds],
          observations,
          final: detail && {
            status: detail.status,
            runs: detail.runs.map(({ progress, ...run }) => ({
              ...run,
              bodyLength: progress?.outputText?.length,
            })),
            posts: detail.posts.map(({ text, ...post }) => ({
              ...post,
              textLength: text.length,
            })),
          },
        },
        null,
        2,
      ),
    );
    await browser.close();
  }
}

if (workerMode === '--live-followup') await liveFollowup();
else if (workerMode && workerMode !== '--warm') await worker();
else await audit();
