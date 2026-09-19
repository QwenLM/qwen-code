/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { verifySourceManifest } from './source-manifest.mjs';

const installation = process.argv[2];
const output = process.argv[3];
const sourceRoot = process.argv[4];
if (!installation || !output || !sourceRoot)
  throw new Error('Usage: verify.mjs INSTALLATION OUTPUT SOURCE_ROOT');
const manifest = JSON.parse(
  await fs.readFile(path.join(installation, 'manifest.json'), 'utf8'),
);
const source = await verifySourceManifest(sourceRoot, manifest);
const root = await fs.mkdtemp('/tmp/qwen-runtime-shell-candidate-');
const results = [];
const allRequests = [];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );
const read = (p) => fs.readFile(p, 'utf8');
const hash = async (p) =>
  createHash('sha256')
    .update(await fs.readFile(p))
    .digest('hex');
const hostNs = await fs.readlink('/proc/self/ns/pid');
const server = http.createServer(async (req, res) => {
  if (req.url === '/probe') {
    res.end('HOST_MODEL_NETWORK');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const name = req.url.split('/')[1];
  const scenario = scenarios.get(name);
  if (!scenario) {
    res.writeHead(404).end('unknown scenario');
    return;
  }
  const toolResults = body.messages?.filter((m) => m.role === 'tool') ?? [];
  const request = {
    scenario: name,
    tools: body.tools?.map((t) => t.function?.name),
    toolResults,
    stream: body.stream,
    startupMarkerPresent: scenario.startupMarker
      ? await exists(scenario.startupMarker)
      : undefined,
  };
  allRequests.push(request);
  const step = scenario.steps.find(
    (_, index) =>
      !toolResults.some((t) => t.tool_call_id === `call_${name}_${index}`),
  );
  const index = scenario.steps.indexOf(step);
  if (step?.before && !step.prepared) {
    await step.before();
    step.prepared = true;
  }
  const calls = step
    ? [
        {
          id: `call_${name}_${index}`,
          type: 'function',
          function: {
            name: step.name ?? 'run_shell_command',
            arguments: JSON.stringify(
              step.args ?? {
                command: step.command,
                is_background: false,
                timeout: 10000,
              },
            ),
          },
        },
      ]
    : undefined;
  const common = {
    id: `chatcmpl-${name}`,
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };
  const content = calls ? '' : `COMPLETE_${name}`;
  const finish = calls ? 'tool_calls' : 'stop';
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...common,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content,
              ...(calls ? { tool_calls: calls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
  } else {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null, extra = {}) =>
      res.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`,
      );
    send({ role: 'assistant', content: '' });
    if (calls)
      send({ tool_calls: calls.map((call, index) => ({ index, ...call })) });
    else send({ content });
    send({}, finish, { usage });
    res.end('data: [DONE]\n\n');
  }
});
const scenarios = new Map();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

async function fixture(name) {
  const dir = path.join(root, name);
  const workspace = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  const home = path.join(dir, 'home');
  const state = path.join(dir, 'state');
  await Promise.all(
    [workspace, outside, home, state].map((p) =>
      fs.mkdir(p, { recursive: true }),
    ),
  );
  return {
    name,
    dir,
    workspace,
    outside,
    home,
    state,
    summary: path.join(dir, 'summary.json'),
    baseUrl: `http://127.0.0.1:${port}/${name}/v1`,
  };
}
async function invoke(f, spec = {}, steps = []) {
  scenarios.set(f.name, { steps, startupMarker: f.startupMarker });
  const specPath = path.join(f.dir, 'spec.json');
  await fs.writeFile(specPath, JSON.stringify({ ...f, ...spec }));
  const env = {
    PATH: f.helperPath ? `${f.helperPath}:/usr/bin:/bin` : '/usr/bin:/bin',
    HOME: f.home,
    QWEN_RUNTIME_DIR: f.state,
    TMPDIR: '/tmp',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    NO_PROXY: '127.0.0.1,localhost',
    CI: 'true',
  };
  let stdout = '',
    stderr = '';
  const child = spawn(
    '/usr/bin/node',
    [path.join(installation, 'launcher.mjs'), specPath],
    {
      cwd: f.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The owned launcher may have exited before the timeout fires.
    }
  }, 45000);
  const exit = await new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(timer);
  await Promise.all([
    fs.writeFile(path.join(f.dir, 'stdout.log'), stdout),
    fs.writeFile(path.join(f.dir, 'stderr.log'), stderr),
  ]);
  const summary = await read(f.summary).then(JSON.parse, () => undefined);
  return {
    ...exit,
    stdout,
    stderr,
    summary,
    requests: allRequests.filter((request) => request.scenario === f.name),
  };
}
async function filesUnder(p) {
  const files = [];
  for (const item of await fs.readdir(p, { withFileTypes: true })) {
    const child = path.join(p, item.name);
    if (item.isDirectory()) files.push(...(await filesUnder(child)));
    else if (item.isFile()) files.push(child);
  }
  return files;
}
async function check(name, run) {
  try {
    const evidence = await run();
    results.push({ name, passed: true, evidence });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
  }
  console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}`);
}
function pipelineOkay(run) {
  assert.equal(run.code, 0, run.stderr + '\n' + run.stdout);
  assert.ok(
    run.requests.length >= 2,
    'Model must receive actual tool response',
  );
  const name = run.requests[0].scenario;
  const last = run.requests.at(-1).toolResults;
  for (const index of scenarios.get(name).steps.keys()) {
    assert.ok(
      last.some((result) => result.tool_call_id === `call_${name}_${index}`),
      `Missing production result for ${name} step ${index}`,
    );
  }
  assert.deepEqual([...new Set(run.requests[0].tools)].sort(), [
    'agent',
    'edit',
    'glob',
    'list_directory',
    'monitor',
    'read_file',
    'run_shell_command',
    'task_stop',
    'write_file',
  ]);
}
async function noNamespaceProcesses(ns) {
  assert.match(ns, /^pid:\[\d+\]$/);
  assert.notEqual(
    ns,
    hostNs,
    'Never enumerate payload processes using host namespace',
  );
  for (let tries = 0; tries < 160; tries++) {
    const matching = [];
    for (const name of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if ((await fs.readlink(`/proc/${name}/ns/pid`)) === ns)
          matching.push(name);
      } catch {
        // A process can exit between listing /proc and reading its namespace.
      }
    }
    if (!matching.length) return;
    await delay(25);
  }
  throw new Error(`Payload descendants still present in ${ns}`);
}
async function controlled(f, mode) {
  const ready = path.join(f.workspace, 'ready.json');
  const gate = path.join(f.workspace, 'gate');
  const once = path.join(f.workspace, 'once');
  const script = path.join(f.workspace, 'controlled.cjs');
  const auto = ['background-ok', 'background-fail'].includes(mode);
  const exit = mode === 'background-fail' ? 7 : 0;
  await fs.writeFile(
    script,
    `const fs=require('node:fs');require('node:child_process').spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.appendFileSync(${JSON.stringify(once)},'x');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({ns:fs.readlinkSync('/proc/self/ns/pid')}));const t=setInterval(()=>{if(${auto ? 'true' : `fs.existsSync(${JSON.stringify(gate)})`}){clearInterval(t);process.exit(${exit})}},${auto ? 500 : 25});`,
  );
  const direct = {
    params: {
      command: `/usr/bin/node ${quote(script)}`,
      is_background: mode.startsWith('background') || mode === 'task-stop',
      timeout: mode === 'timeout' ? 1000 : 10000,
    },
    ready,
  };
  if (mode === 'promoted' || mode === 'promoted-lost') direct.promote = true;
  if (mode === 'cancel') direct.cancel = true;
  if (mode === 'task-stop') direct.taskStop = true;
  if (['lost', 'background-lost', 'promoted-lost'].includes(mode))
    direct.removeReceipt = true;
  if (['promoted', 'lost', 'background-lost', 'promoted-lost'].includes(mode))
    direct.gate = gate;
  const run = await invoke(f, { direct });
  assert.equal(run.code, 0, run.stderr + '\n' + JSON.stringify(run.summary));
  assert.ok(run.summary, 'Must return actual ShellTool result');
  const ns = JSON.parse(await read(ready)).ns;
  await noNamespaceProcesses(ns);
  assert.equal(await read(once), 'x', 'Command must run once');
  const text = JSON.stringify(run.summary.result);
  const tasks = run.summary.tasks;
  if (mode === 'promoted' || mode === 'background-ok')
    assert.equal(tasks[0]?.status, 'completed', JSON.stringify(tasks));
  if (['background-fail', 'background-lost', 'promoted-lost'].includes(mode))
    assert.equal(tasks[0]?.status, 'failed', JSON.stringify(tasks));
  if (mode === 'task-stop')
    assert.equal(tasks[0]?.status, 'cancelled', JSON.stringify(tasks));
  if (mode === 'lost')
    assert.match(
      text,
      /unconfirmed|not confirmed|could not.*confirm|receipt|may have run/i,
    );
  if (mode === 'cancel') assert.match(text, /cancel|abort/i);
  if (mode === 'timeout') assert.match(text, /timed out|timeout/i);
  return {
    namespace: ns,
    once: 'x',
    result: run.summary.result,
    tasks,
    descendantsGone: true,
  };
}
try {
  await check(
    'production model/tool/session flow confines workspace and network',
    async () => {
      const f = await fixture('main');
      const inside = path.join(f.workspace, 'inside');
      const outside = path.join(f.outside, 'outside');
      const probe = path.join(f.workspace, 'net.cjs');
      await fs.writeFile(
        probe,
        `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('NETWORK_ESCAPED');s.destroy();process.exit(4)});s.on('error',()=>console.log('NETWORK_BLOCKED'));s.setTimeout(1000,()=>{console.log('NETWORK_BLOCKED');s.destroy()});`,
      );
      const run = await invoke(f, {}, [
        { command: `printf allowed > ${quote(inside)}` },
        { command: `printf forbidden > ${quote(outside)}` },
        { command: `/usr/bin/node ${quote(probe)}` },
      ]);
      pipelineOkay(run);
      assert.equal(await read(inside), 'allowed');
      assert.equal(await exists(outside), false);
      assert.match(
        JSON.stringify(run.requests),
        /Read-only file system|Permission denied/,
      );
      assert.match(JSON.stringify(run.requests), /NETWORK_BLOCKED/);
      assert.doesNotMatch(JSON.stringify(run.requests), /NETWORK_ESCAPED/);
      const recordings = (await filesUnder(f.state)).filter((p) =>
        p.endsWith('.jsonl'),
      );
      assert.ok(recordings.length, 'Host chat/session JSONL must persist');
      assert.ok(
        (await Promise.all(recordings.map(read))).some((text) =>
          text.includes('run_shell_command'),
        ),
        'Session recording must contain actual shell turn',
      );
      return {
        fixture: f.dir,
        modelRequests: run.requests.length,
        sessionId: run.summary.sessionId,
        recordings,
        inside: 'allowed',
        outsideAbsent: true,
        network: 'blocked',
      };
    },
  );
  await check(
    'repository clean filters cannot execute on the host',
    async () => {
      const f = await fixture('git-filter');
      const marker = path.join(f.outside, 'filter-marker');
      const attempt = path.join(f.workspace, 'filter-attempt');
      const tracked = path.join(f.workspace, 'tracked.txt');
      const git = (...args) =>
        execFileSync('/usr/bin/git', args, {
          cwd: f.workspace,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: f.home,
            LANG: 'C.UTF-8',
            GIT_CONFIG_NOSYSTEM: '1',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      git('init', '--quiet');
      await fs.writeFile(tracked, 'before\n');
      await fs.writeFile(
        path.join(f.workspace, '.gitattributes'),
        'tracked.txt filter=fixture\n',
      );
      git('add', '--', 'tracked.txt', '.gitattributes');
      git(
        '-c',
        'user.name=Sandbox fixture',
        '-c',
        'user.email=sandbox@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture baseline',
      );
      git(
        'config',
        '--local',
        'filter.fixture.clean',
        `printf filter-ran >> ${quote(marker)}; printf attempted >> ${quote(attempt)}; cat`,
      );
      git('config', '--local', 'filter.fixture.required', 'true');
      await fs.writeFile(tracked, 'after!\n');
      const changedTime = new Date(Date.now() + 5000);
      await fs.utimes(tracked, changedTime, changedTime);
      assert.equal(await exists(marker), false);
      f.startupMarker = marker;
      const run = await invoke(f, {}, [
        { command: 'printf SAFE_NO_GIT_TOOL_CALL' },
        { command: 'git status --short' },
      ]);
      pipelineOkay(run);
      assert.equal(
        run.requests[0].startupMarkerPresent,
        false,
        'Repository clean filter must not execute during host prompt startup',
      );
      assert.ok(run.requests.every((request) => !request.startupMarkerPresent));
      assert.equal(await exists(marker), false);
      assert.match(await read(attempt), /^(attempted)+$/);
      assert.match(
        JSON.stringify(run.requests),
        /Read-only file system|Permission denied/,
        'Explicit confined git must exercise the configured filter',
      );
      return {
        fixture: f.dir,
        beforeFirstModelReply: run.requests[0].startupMarkerPresent,
        outsideMarkerAbsent: true,
        confinedFilterAttempt: await read(attempt),
      };
    },
  );
  await check('real sed cannot edit outside workspace', async () => {
    const f = await fixture('sed');
    const file = path.join(f.outside, 'existing.txt');
    await fs.writeFile(file, 'before\n');
    const run = await invoke(f, {}, [
      { command: `sed -i 's/before/after/' ${quote(file)}` },
    ]);
    pipelineOkay(run);
    assert.equal(await read(file), 'before\n');
    assert.match(
      JSON.stringify(run.requests),
      /Read-only file system|Permission denied/,
    );
    return { fixture: f.dir, unchanged: true };
  });
  await check(
    'unsupported NotebookEdit tool is rejected before a host write',
    async () => {
      const f = await fixture('notebook');
      const file = path.join(f.outside, 'existing.txt');
      await fs.writeFile(file, 'before\n');
      const run = await invoke(f, {}, [
        {
          name: 'notebook_edit',
          args: {
            notebook_path: file,
            new_source: 'after',
            edit_mode: 'replace',
            cell_number: 0,
          },
        },
      ]);
      pipelineOkay(run);
      assert.equal(await read(file), 'before\n');
      assert.match(
        JSON.stringify(run.requests),
        /not found|unknown|not registered|not available/i,
      );
      return { fixture: f.dir, unchanged: true, tools: run.requests[0].tools };
    },
  );
  await check(
    'read-only policy denies workspace mutation under YOLO',
    async () => {
      const f = await fixture('readonly');
      const file = path.join(f.workspace, 'denied');
      const run = await invoke(f, { filesystem: 'read-only' }, [
        { command: `printf forbidden > ${quote(file)}` },
      ]);
      pipelineOkay(run);
      assert.equal(await exists(file), false);
      assert.match(
        JSON.stringify(run.requests),
        /Read-only file system|Permission denied/,
      );
      return { fixture: f.dir, writeDenied: true };
    },
  );
  await check(
    'second runtime writes only its own admitted workspace',
    async () => {
      const f = await fixture('second');
      const first = path.join(root, 'main/workspace/from-second');
      const own = path.join(f.workspace, 'own');
      const run = await invoke(f, {}, [
        {
          command: `printf own > ${quote(own)}; printf forbidden > ${quote(first)}`,
        },
      ]);
      pipelineOkay(run);
      assert.equal(await read(own), 'own');
      assert.equal(await exists(first), false);
      return { fixture: f.dir, ownAllowed: true, firstDenied: true };
    },
  );
  await check(
    'two Config instances in one process retain separate grants',
    async () => {
      const a = await fixture('shared-a');
      const b = await fixture('shared-b');
      const ownA = path.join(a.workspace, 'own');
      const ownB = path.join(b.workspace, 'own');
      const deniedA = path.join(a.workspace, 'written-by-b');
      const deniedB = path.join(b.workspace, 'written-by-a');
      const fileA = path.join(a.workspace, 'file-own-a.txt');
      const fileB = path.join(b.workspace, 'file-own-b.txt');
      const crossFileA = path.join(a.workspace, 'file-from-b.txt');
      const crossFileB = path.join(b.workspace, 'file-from-a.txt');
      scenarios.set(b.name, {
        steps: [
          {
            command: `printf own-b > ${quote(ownB)}; printf forbidden > ${quote(deniedA)}`,
          },
          { name: 'write_file', args: { file_path: fileB, content: 'file-b' } },
          {
            name: 'write_file',
            args: { file_path: crossFileA, content: 'escaped' },
          },
        ],
      });
      const run = await invoke(
        a,
        { second: { workspace: b.workspace, baseUrl: b.baseUrl } },
        [
          {
            command: `printf own-a > ${quote(ownA)}; printf forbidden > ${quote(deniedB)}`,
          },
          { name: 'write_file', args: { file_path: fileA, content: 'file-a' } },
          {
            name: 'write_file',
            args: { file_path: crossFileB, content: 'escaped' },
          },
        ],
      );
      pipelineOkay(run);
      const bRequests = allRequests.filter((r) => r.scenario === b.name);
      assert.ok(bRequests.length >= 2);
      assert.deepEqual([...new Set(bRequests[0].tools)].sort(), [
        'agent',
        'edit',
        'glob',
        'list_directory',
        'monitor',
        'read_file',
        'run_shell_command',
        'task_stop',
        'write_file',
      ]);
      assert.equal(run.summary.runtimes.length, 2);
      assert.notEqual(
        run.summary.runtimes[0].sessionId,
        run.summary.runtimes[1].sessionId,
      );
      assert.equal(await read(ownA), 'own-a');
      assert.equal(await read(ownB), 'own-b');
      assert.equal(await exists(deniedA), false);
      assert.equal(await exists(deniedB), false);
      assert.equal(await read(fileA), 'file-a');
      assert.equal(await read(fileB), 'file-b');
      assert.equal(await exists(crossFileA), false);
      assert.equal(await exists(crossFileB), false);
      return {
        fixtures: [a.dir, b.dir],
        sessionIds: run.summary.runtimes.map((r) => r.sessionId),
        bothOwnWritesAllowed: true,
        bothCrossWritesDenied: true,
      };
    },
  );
  await check(
    'bare startup ignores ambient hooks discovery and MCP',
    async () => {
      const f = await fixture('ambient');
      const marker = path.join(f.outside, 'must-not-exist');
      const markerCommand = `printf escaped > ${quote(marker)}`;
      const hooks = {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: markerCommand }],
          },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: markerCommand }] },
        ],
      };
      const run = await invoke(
        f,
        {
          settings: {
            hooks,
            tools: {
              discoveryCommand: markerCommand,
              callCommand: markerCommand,
            },
            mcpServers: {
              probe: { command: '/bin/sh', args: ['-c', markerCommand] },
            },
          },
          hooks: { userHooks: hooks, projectHooks: hooks },
        },
        [{ command: 'printf SAFE_BARE_STARTUP' }],
      );
      pipelineOkay(run);
      assert.equal(await exists(marker), false);
      assert.match(JSON.stringify(run.requests), /SAFE_BARE_STARTUP/);
      return {
        fixture: f.dir,
        ambientMarkersAbsent: true,
        tools: run.requests[0].tools,
      };
    },
  );
  for (const entrypoint of ['mcp', 'extensions', 'lsp', 'acp']) {
    await check(
      `explicit unsupported startup is rejected: ${entrypoint}`,
      async () => {
        const f = await fixture(`startup-${entrypoint}`);
        const marker = path.join(f.outside, 'must-not-exist');
        const command = `printf escaped > ${quote(marker)}`;
        const argv =
          entrypoint === 'mcp'
            ? {
                mcpConfig: JSON.stringify({
                  mcpServers: {
                    probe: { command: '/bin/sh', args: ['-c', command] },
                  },
                }),
              }
            : entrypoint === 'extensions'
              ? { extensions: ['sandbox-test-extension'] }
              : entrypoint === 'lsp'
                ? { experimentalLsp: true }
                : { acp: true };
        const run = await invoke(f, { argv, startupOnly: true });
        assert.notEqual(run.code, 0, 'Unsupported startup must fail closed');
        assert.match(
          run.stderr + JSON.stringify(run.summary),
          /sandbox.*(requires|does not.*support)/i,
        );
        assert.equal(await exists(marker), false);
        assert.equal(
          run.requests.length,
          0,
          'Startup rejection precedes model work',
        );
        return { fixture: f.dir, code: run.code, markerAbsent: true };
      },
    );
  }
  await check(
    'setup failure never falls back or replays unconfined',
    async () => {
      const f = await fixture('setup');
      const file = path.join(f.workspace, 'must-not-exist');
      const run = await invoke(f, { bwrapPath: '/usr/bin/false' }, [
        { command: `printf forbidden > ${quote(file)}` },
      ]);
      assert.notEqual(run.code, 0);
      assert.equal(run.signal, null);
      assert.equal(
        run.requests.length,
        0,
        'Probe rejection precedes model work',
      );
      assert.equal(await exists(file), false);
      assert.match(
        JSON.stringify(run.summary),
        /Sandbox capability probe failed/i,
      );
      return { fixture: f.dir, sideEffectAbsent: true, startupRejected: true };
    },
  );
  await check(
    'production Read Write Edit preserve bytes modes and read cache',
    async () => {
      const f = await fixture('file-semantics');
      const existing = path.join(f.workspace, 'existing.txt');
      const wide = path.join(f.workspace, 'wide.txt');
      const created = path.join(f.workspace, 'nested/new.txt');
      const editedNew = path.join(f.workspace, 'edit-created.txt');
      await fs.writeFile(existing, Buffer.from('\ufeffalpha\r\nbeta\r\n'));
      await fs.chmod(existing, 0o751);
      await fs.writeFile(
        wide,
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('wide-before\r\n', 'utf16le'),
        ]),
      );
      await fs.chmod(wide, 0o600);
      const run = await invoke(f, {}, [
        { name: 'read_file', args: { file_path: existing } },
        {
          name: 'edit',
          args: {
            file_path: existing,
            old_string: 'alpha',
            new_string: 'ALPHA',
          },
        },
        {
          name: 'write_file',
          args: { file_path: existing, content: 'ALPHA\nbeta-write\n' },
        },
        { name: 'read_file', args: { file_path: wide } },
        {
          name: 'edit',
          args: {
            file_path: wide,
            old_string: 'wide-before',
            new_string: 'wide-after',
          },
        },
        {
          name: 'write_file',
          args: {
            file_path: created,
            content: '中文🙂 first\nrepeat repeat\n',
          },
        },
        {
          name: 'edit',
          args: {
            file_path: created,
            old_string: 'repeat',
            new_string: 'changed',
            replace_all: true,
          },
        },
        {
          name: 'edit',
          args: {
            file_path: editedNew,
            old_string: '',
            new_string: 'new-file\n',
          },
        },
      ]);
      pipelineOkay(run);
      assert.deepEqual(
        await fs.readFile(existing),
        Buffer.from('\ufeffALPHA\r\nbeta-write\r\n'),
      );
      assert.equal((await fs.stat(existing)).mode & 0o777, 0o751);
      assert.deepEqual(
        await fs.readFile(wide),
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('wide-after\r\n', 'utf16le'),
        ]),
      );
      assert.equal((await fs.stat(wide)).mode & 0o777, 0o600);
      assert.equal(await read(created), '中文🙂 first\nchanged changed\n');
      assert.equal(await read(editedNew), 'new-file\n');
      return {
        fixture: f.dir,
        utf8BomCrlf: true,
        utf16leBomCrlf: true,
        modes: ['0751', '0600'],
        newFileEditWithoutRead: true,
        replaceAll: true,
      };
    },
  );
  await check(
    'file writes follow allowed relative and dangling symlinks',
    async () => {
      const f = await fixture('file-links');
      const target = path.join(f.workspace, 'target.txt');
      const link = path.join(f.workspace, 'link.txt');
      const dangling = path.join(f.workspace, 'dangling.txt');
      await fs.writeFile(target, 'before\n');
      await fs.chmod(target, 0o600);
      await fs.symlink('target.txt', link);
      await fs.symlink('new-target.txt', dangling);
      const run = await invoke(f, {}, [
        { name: 'read_file', args: { file_path: link } },
        {
          name: 'edit',
          args: { file_path: link, old_string: 'before', new_string: 'after' },
        },
        {
          name: 'write_file',
          args: { file_path: dangling, content: 'created-through-link\n' },
        },
      ]);
      pipelineOkay(run);
      assert.equal(await read(target), 'after\n');
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
      assert.equal(await fs.readlink(link), 'target.txt');
      assert.equal(await fs.readlink(dangling), 'new-target.txt');
      assert.equal(
        await read(path.join(f.workspace, 'new-target.txt')),
        'created-through-link\n',
      );
      return {
        fixture: f.dir,
        relativeLinkPreserved: true,
        danglingLinkPreserved: true,
      };
    },
  );
  await check(
    'file tools deny outside direct parent and leaf symlink writes without litter',
    async () => {
      const f = await fixture('file-outside');
      const existing = path.join(f.outside, 'existing.txt');
      const parent = path.join(f.workspace, 'outside-parent');
      const leaf = path.join(f.workspace, 'outside-leaf.txt');
      await fs.writeFile(existing, 'outside-before\n');
      await fs.symlink(f.outside, parent);
      await fs.symlink(existing, leaf);
      const run = await invoke(f, {}, [
        {
          name: 'write_file',
          args: {
            file_path: path.join(f.outside, 'direct/missing.txt'),
            content: 'denied',
          },
        },
        {
          name: 'write_file',
          args: {
            file_path: path.join(parent, 'nested/missing.txt'),
            content: 'denied',
          },
        },
        { name: 'read_file', args: { file_path: leaf } },
        {
          name: 'edit',
          args: {
            file_path: leaf,
            old_string: 'outside-before',
            new_string: 'escaped',
          },
        },
        { name: 'write_file', args: { file_path: leaf, content: 'escaped' } },
      ]);
      pipelineOkay(run);
      assert.equal(await read(existing), 'outside-before\n');
      assert.deepEqual((await fs.readdir(f.outside)).sort(), ['existing.txt']);
      assert.equal(await fs.readlink(parent), f.outside);
      assert.equal(await fs.readlink(leaf), existing);
      assert.match(
        JSON.stringify(run.requests),
        /read.only|permission denied|EACCES|EROFS|EPERM/i,
      );
      return {
        fixture: f.dir,
        outsideUnchanged: true,
        noOutsideMkdirOrTemp: true,
        linksPreserved: true,
      };
    },
  );
  await check(
    'file prior-read enforcement rejects unseen and stale content',
    async () => {
      const f = await fixture('file-prior-read');
      const unseenEdit = path.join(f.workspace, 'unseen-edit.txt');
      const unseenWrite = path.join(f.workspace, 'unseen-write.txt');
      const stale = path.join(f.workspace, 'stale.txt');
      for (const p of [unseenEdit, unseenWrite, stale])
        await fs.writeFile(p, 'before\n');
      const run = await invoke(f, {}, [
        {
          name: 'edit',
          args: {
            file_path: unseenEdit,
            old_string: 'before',
            new_string: 'escaped',
          },
        },
        {
          name: 'write_file',
          args: { file_path: unseenWrite, content: 'escaped' },
        },
        { name: 'read_file', args: { file_path: stale } },
        {
          name: 'edit',
          args: {
            file_path: stale,
            old_string: 'before',
            new_string: 'escaped',
          },
          before: () => fs.writeFile(stale, 'host-changed-longer\n'),
        },
      ]);
      pipelineOkay(run);
      assert.equal(await read(unseenEdit), 'before\n');
      assert.equal(await read(unseenWrite), 'before\n');
      assert.equal(await read(stale), 'host-changed-longer\n');
      assert.match(
        JSON.stringify(run.requests),
        /read.*before|not.*read|prior.read/i,
      );
      assert.match(JSON.stringify(run.requests), /changed|modified/i);
      return {
        fixture: f.dir,
        unseenWritesDenied: true,
        staleEditDenied: true,
      };
    },
  );
  await check('read-only policy denies Write and Edit under YOLO', async () => {
    const f = await fixture('file-readonly');
    const existing = path.join(f.workspace, 'existing.txt');
    const fresh = path.join(f.workspace, 'nested/new.txt');
    await fs.writeFile(existing, 'before\n');
    const run = await invoke(f, { filesystem: 'read-only' }, [
      { name: 'read_file', args: { file_path: existing } },
      {
        name: 'edit',
        args: {
          file_path: existing,
          old_string: 'before',
          new_string: 'escaped',
        },
      },
      { name: 'write_file', args: { file_path: fresh, content: 'escaped' } },
    ]);
    pipelineOkay(run);
    assert.equal(await read(existing), 'before\n');
    assert.equal(await exists(path.dirname(fresh)), false);
    assert.match(
      JSON.stringify(run.requests),
      /read.only|permission denied|EACCES|EROFS|EPERM/i,
    );
    return { fixture: f.dir, existingUnchanged: true, noNewDirectories: true };
  });
  await check(
    'file worker transport accepts content larger than one MiB',
    async () => {
      const f = await fixture('file-large');
      const file = path.join(f.workspace, 'large.txt');
      const content = '中文🙂'.repeat(110000) + '\n';
      assert.ok(Buffer.byteLength(content) > 1024 * 1024);
      const run = await invoke(f, {}, [
        { name: 'write_file', args: { file_path: file, content } },
      ]);
      pipelineOkay(run);
      assert.equal(await read(file), content);
      return {
        fixture: f.dir,
        bytes: Buffer.byteLength(content),
        sha256: await hash(file),
      };
    },
  );
  await check('PDF Read is rejected before host helper execution', async () => {
    const f = await fixture('file-pdf');
    const file = path.join(f.workspace, 'document.pdf');
    const marker = path.join(f.outside, 'pdf-helper');
    f.helperPath = path.join(f.dir, 'helpers');
    await fs.mkdir(f.helperPath);
    for (const name of ['pdfinfo', 'pdftotext', 'pdftoppm']) {
      const helper = path.join(f.helperPath, name);
      await fs.writeFile(
        helper,
        `#!/bin/sh\nprintf ${name} >> ${quote(marker)}\nexit 1\n`,
        { mode: 0o755 },
      );
    }
    await fs.writeFile(file, '%PDF-1.4\nfixture\n');
    const run = await invoke(f, {}, [
      { name: 'read_file', args: { file_path: file, pages: '1' } },
    ]);
    pipelineOkay(run);
    assert.equal(await exists(marker), false);
    assert.match(
      JSON.stringify(run.requests),
      /PDF.*sandbox|sandbox.*PDF|PDF.*not.*supported/i,
    );
    return { fixture: f.dir, noHostPdfHelpers: true };
  });
  await check(
    'Write and Edit reject special files without blocking',
    async () => {
      const f = await fixture('file-special');
      const fifo = path.join(f.workspace, 'fifo');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      const run = await invoke(f, {}, [
        { name: 'write_file', args: { file_path: fifo, content: 'denied' } },
        {
          name: 'edit',
          args: { file_path: fifo, old_string: '', new_string: 'denied' },
        },
      ]);
      pipelineOkay(run);
      assert.equal((await fs.stat(fifo)).isFIFO(), true);
      assert.match(
        JSON.stringify(run.requests),
        /regular file|special file|not.*file/i,
      );
      return {
        fixture: f.dir,
        fifoUnchanged: true,
        completedWithoutReader: true,
      };
    },
  );
  await check(
    'file setup failure never falls back to host mutation',
    async () => {
      const f = await fixture('file-setup');
      const file = path.join(f.workspace, 'nested/denied.txt');
      const run = await invoke(f, { bwrapPath: '/usr/bin/false' }, [
        { name: 'write_file', args: { file_path: file, content: 'escaped' } },
      ]);
      assert.notEqual(run.code, 0);
      assert.equal(run.signal, null);
      assert.equal(
        run.requests.length,
        0,
        'Probe rejection precedes model work',
      );
      assert.equal(await exists(path.dirname(file)), false);
      assert.match(
        JSON.stringify(run.summary),
        /Sandbox capability probe failed/i,
      );
      return {
        fixture: f.dir,
        noHostMkdirOrWrite: true,
        startupRejected: true,
      };
    },
  );
  for (const mode of [
    'background-ok',
    'background-fail',
    'promoted',
    'cancel',
    'timeout',
    'task-stop',
    'lost',
    'background-lost',
    'promoted-lost',
  ]) {
    await check(`production ShellTool lifecycle: ${mode}`, async () =>
      controlled(await fixture(mode), mode),
    );
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const actualHashes = {};
  const artifactErrors = [];
  for (const name of Object.keys(manifest.artifacts)) {
    try {
      actualHashes[name] = await hash(path.join(installation, name));
    } catch (error) {
      artifactErrors.push(`${name}: ${error.message}`);
    }
  }
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    if (actualHashes[name] !== expected) {
      artifactErrors.push(`${name}: hash differs from the candidate build`);
    }
  }
  results.push({
    name: 'artifact integrity after verification',
    passed: artifactErrors.length === 0,
    errors: artifactErrors,
  });
  let bwrap;
  try {
    bwrap = execFileSync('/usr/bin/bwrap', ['--version'], {
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    bwrap = `unavailable: ${error.code ?? error.message}`;
  }
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        time: new Date().toISOString(),
        root,
        installation,
        hostNs,
        node: process.version,
        kernel: execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim(),
        bwrap,
        source,
        expectedArtifactHashes: manifest.artifacts,
        actualHashes,
        results,
        requests: allRequests,
      },
      null,
      2,
    ),
  );
}
console.log(
  JSON.stringify({
    root,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    output,
  }),
);
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
