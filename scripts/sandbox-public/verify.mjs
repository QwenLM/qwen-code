/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const installation = process.argv[2];
const outputFile = process.argv[3];
const filter = process.argv[4] ?? '';
if (!installation || !outputFile || process.platform !== 'linux')
  throw new Error(
    'Usage on Linux: public-verify.mjs INSTALLATION REPORT [CASE_REGEX]',
  );
const binary = process.execPath;
const testPath = `${path.dirname(binary)}:/usr/bin:/bin`;
const installedCli = path.join(installation, 'cli.js');
const bun = process.env.QWEN_SANDBOX_TEST_BUN;
assert.ok(
  bun && path.isAbsolute(bun),
  'QWEN_SANDBOX_TEST_BUN must be an absolute executable path',
);
const tmux = '/usr/bin/tmux';
const root = await fs.mkdtemp(
  path.join(os.tmpdir(), 'qwen-bwrap-public-candidate-'),
);
const version = spawnSync(binary, [installedCli, '--version'], {
  env: { PATH: testPath, HOME: root },
  encoding: 'utf8',
}).stdout.trim();
const scenarios = new Map();
const results = [];
const activeChildren = new Set();
const activeSockets = new Set();
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.on(signal, () => {
    for (const child of activeChildren) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    for (const socket of activeSockets)
      spawnSync(tmux, ['-L', socket, 'kill-server']);
    process.exit(code);
  });
}
const requests = [];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
const policy = {
  backend: 'bwrap',
  filesystem: 'workspace-write',
  network: 'closed',
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/probe') {
    res.end('HOST_NETWORK_OK');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const name = req.url.split('/')[1];
  const scenario = scenarios.get(name);
  if (scenario?.responseDelay) await delay(scenario.responseDelay);
  const nested =
    !!scenario?.nestedSteps &&
    body.messages?.some(
      (m) =>
        m.role === 'user' &&
        JSON.stringify(m.content).includes('NESTED_BOUNDARY'),
    );
  const activeSteps = nested ? scenario.nestedSteps : scenario?.steps;
  const callName = nested ? `${name}_nested` : name;
  const toolResults = body.messages?.filter((m) => m.role === 'tool') ?? [];
  requests.push({
    name,
    nested,
    url: req.url,
    messages: body.messages,
    tools: body.tools?.map((t) => t.function?.name),
    toolResults,
    stream: body.stream,
  });
  const index =
    activeSteps?.findIndex(
      (_, i) =>
        !toolResults.some((r) => r.tool_call_id === `call_${callName}_${i}`),
    ) ?? -1;
  const step = activeSteps?.[index];
  if (!step && scenario?.waitForFile) {
    for (let i = 0; i < 200 && !(await exists(scenario.waitForFile)); i++)
      await delay(25);
  }
  const calls = step
    ? [
        {
          id: `call_${callName}_${index}`,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ]
    : undefined;
  const content = step ? '' : 'BASELINE_COMPLETE';
  const common = {
    id: `chatcmpl-${name}`,
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
  };
  const finish = calls ? 'tool_calls' : 'stop';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    send({ role: 'assistant', content: '' });
    send(
      calls
        ? { tool_calls: calls.map((call, index) => ({ ...call, index })) }
        : { content },
    );
    send({}, finish);
    res.end('data: [DONE]\n\n');
  } else {
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
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
async function fixture(
  name,
  user = { tools: { executionSandbox: policy } },
  system = {},
  workspace = {},
) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'home');
  const qwenHome = path.join(dir, 'qwen-home');
  const runtime = path.join(dir, 'runtime');
  const cwd = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  const helper = path.join(dir, 'helpers');
  await Promise.all(
    [home, qwenHome, runtime, cwd, outside, helper].map((p) =>
      fs.mkdir(p, { recursive: true }),
    ),
  );
  await fs.mkdir(path.join(cwd, '.qwen'));
  const settings = {
    ui: { theme: 'Default' },
    security: {
      folderTrust: { enabled: false },
      auth: { selectedType: 'openai' },
    },
    ...user,
  };
  await Promise.all([
    fs.writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify(settings),
    ),
    fs.writeFile(path.join(dir, 'system.json'), JSON.stringify(system)),
    fs.writeFile(path.join(dir, 'defaults.json'), '{}'),
    fs.writeFile(
      path.join(cwd, '.qwen/settings.json'),
      JSON.stringify(workspace),
    ),
  ]);
  const marker = path.join(dir, 'bwrap-probe.marker');
  await fs.writeFile(
    path.join(helper, 'bwrap'),
    `#!/bin/sh\nprintf 'probe\\n' >> ${quote(marker)}\nprintf 'BASELINE_STUB_BWRAP_REACHED\\n' >&2\nexit 43\n`,
    { mode: 0o755 },
  );
  const env = {
    PATH: testPath,
    HOME: home,
    QWEN_HOME: qwenHome,
    QWEN_RUNTIME_DIR: runtime,
    QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(dir, 'system.json'),
    QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(dir, 'defaults.json'),
    TMPDIR: dir,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    NO_PROXY: '127.0.0.1,localhost',
    CI: 'true',
  };
  const args = [
    '--auth-type',
    'openai',
    '--openai-api-key',
    'sk-mock',
    '--openai-base-url',
    `http://127.0.0.1:${port}/${name}/v1`,
    '--model',
    'mock-model',
    '--approval-mode',
    'yolo',
  ];
  return {
    name,
    dir,
    home,
    qwenHome,
    runtime,
    cwd,
    outside,
    helper,
    marker,
    env,
    args,
    settings,
    system,
    workspace,
  };
}
async function invoke(f, args, extraEnv = {}) {
  let stdout = '',
    stderr = '';
  const command = f.maskBwrap ? '/usr/bin/bwrap' : binary;
  const commandArgs = f.maskBwrap
    ? [
        '--die-with-parent',
        '--unshare-user',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--bind',
        f.dir,
        f.dir,
        '--ro-bind',
        path.join(f.helper, 'bwrap'),
        '/usr/bin/bwrap',
        '--',
        binary,
        installedCli,
        ...args,
      ]
    : [installedCli, ...args];
  const child = spawn(command, commandArgs, {
    cwd: f.cwd,
    env: { ...f.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  activeChildren.add(child);
  let timedOut = false;
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* The owned process may already have exited. */
    }
  }, 45000);
  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    activeChildren.delete(child);
  }
  await fs.writeFile(path.join(f.dir, 'stdout.log'), stdout);
  await fs.writeFile(path.join(f.dir, 'stderr.log'), stderr);
  assert.equal(timedOut, false, `CLI timed out: ${args.join(' ')}`);
  assert.equal(exit.signal, null, `CLI terminated by ${exit.signal}`);
  return {
    ...exit,
    stdout,
    stderr,
    args,
    extraEnv,
    requests: requests.filter((r) => r.name === f.name),
  };
}
async function check(name, run) {
  if (filter && !new RegExp(filter).test(name)) return;
  try {
    results.push({ name, passed: true, evidence: await run() });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
  }
  console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}`);
}

const toolText = (run) =>
  JSON.stringify(run.requests.at(-1)?.toolResults ?? []);
function completed(run, count) {
  assert.equal(run.code, 0, run.stderr + '\n' + run.stdout);
  assert.ok(
    run.requests.length >= count + 1,
    'Expected actual model/tool results',
  );
  for (let i = 0; i < count; i++)
    assert.ok(
      run.requests
        .at(-1)
        .toolResults.some(
          (r) => r.tool_call_id === `call_${run.requests[0].name}_${i}`,
        ),
      `Missing response ${i}`,
    );
}
const shellStep = (command) => ({
  name: 'run_shell_command',
  args: { command, is_background: false, timeout: 10000 },
});
async function model(
  f,
  steps,
  extraArgs = [],
  extraEnv = {},
  prompt = 'Run the disposable boundary fixture',
) {
  scenarios.set(f.name, {
    steps,
    waitForFile: f.waitForFile,
    responseDelay: f.responseDelay,
  });
  return invoke(
    f,
    [...f.args, ...extraArgs, '--output-format', 'json', '-p', prompt],
    extraEnv,
  );
}
async function listFiles(dir) {
  const result = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) result.push(...(await listFiles(p)));
    else if (ent.isFile()) result.push(p);
  }
  return result;
}
async function confinement(
  f,
  { writable = true, network = false, args = [], env = {} } = {},
) {
  const inside = path.join(f.cwd, 'inside.txt'),
    outside = path.join(f.outside, 'outside.txt');
  const netScript = path.join(f.cwd, 'network.cjs');
  await fs.writeFile(
    netScript,
    `const net=require('node:net');const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('TOOL_NETWORK_ALLOWED');s.destroy()});s.on('error',()=>console.log('TOOL_NETWORK_DENIED'));s.setTimeout(1000,()=>{console.log('TOOL_NETWORK_DENIED');s.destroy()});`,
  );
  const run = await model(
    f,
    [
      shellStep(
        `printf inside > ${quote(inside)}; printf outside > ${quote(outside)}`,
      ),
      shellStep(`${quote(binary)} ${quote(netScript)}`),
    ],
    args,
    env,
  );
  completed(run, 2);
  assert.doesNotMatch(run.stderr, /running headless.*no sandbox/);
  assert.equal(await exists(inside), writable);
  assert.equal(await exists(outside), false);
  if (writable) assert.equal(await fs.readFile(inside, 'utf8'), 'inside');
  assert.match(
    toolText(run),
    network ? /TOOL_NETWORK_ALLOWED/ : /TOOL_NETWORK_DENIED/,
  );
  assert.ok(
    (await listFiles(f.runtime)).some((p) => p.endsWith('.jsonl')),
    'Host session writes must survive',
  );
  return {
    fixture: f.dir,
    inside: writable,
    outside: false,
    toolNetwork: network ? 'open' : 'closed',
    modelRequests: run.requests.length,
  };
}
try {
  await check('public user policy confines native model tools', async () =>
    confinement(await fixture('user')),
  );
  for (const source of ['settings', 'env'])
    await check(`Omni ${source} cannot launch host media helpers`, async () => {
      const f = await fixture(`omni-${source}`, {
        tools: { executionSandbox: { ...policy, filesystem: 'read-only' } },
        ...(source === 'settings' ? { omni: { enabled: true } } : {}),
      });
      const helperDir = path.join(f.dir, 'omni-bin');
      await fs.mkdir(helperDir);
      const markers = [];
      for (const tool of ['ffmpeg', 'ffprobe']) {
        const marker = path.join(f.outside, `${tool}.marker`);
        markers.push(marker);
        const shim = path.join(helperDir, tool);
        await fs.writeFile(
          shim,
          `#!/bin/sh\nprintf '${tool}\\n' >> ${quote(marker)}\nprintf '${tool} version 7.0 fixture\\n'\n`,
          { mode: 0o755 },
        );
        const control = spawnSync(shim, ['--version'], {
          env: f.env,
          encoding: 'utf8',
        });
        assert.equal(control.status, 0, control.stderr);
        assert.match(control.stdout, new RegExp(`${tool} version`));
        assert.equal(await fs.readFile(marker, 'utf8'), `${tool}\n`);
        await fs.unlink(marker);
      }
      const run = await model(
        f,
        [shellStep('printf OMNI_DISABLED_SANDBOX_TURN')],
        [],
        {
          PATH: `${helperDir}:${testPath}`,
          ...(source === 'env' ? { QWEN_CODE_ENABLE_OMNI: '1' } : {}),
        },
      );
      completed(run, 1);
      assert.match(toolText(run), /OMNI_DISABLED_SANDBOX_TURN/);
      for (const marker of markers) assert.equal(await exists(marker), false);
      assert.ok(
        run.requests.every((request) =>
          request.tools.every((tool) => !tool.startsWith('omni_')),
        ),
        'Sandbox model requests must not advertise Omni tools',
      );
      return {
        fixture: f.dir,
        source,
        modelRequests: run.requests.length,
        helperPositiveControlsPassed: true,
        mediaHelpersRan: false,
        omniToolsAdvertised: false,
      };
    });
  await check(
    'project dotenv cannot disable operator confinement',
    async () => {
      const f = await fixture('dotenv');
      await fs.writeFile(path.join(f.cwd, '.env'), 'QWEN_SANDBOX=false\n');
      return confinement(f);
    },
  );
  await check(
    'public model Read Write Edit use confined file mutations',
    async () => {
      const f = await fixture('files');
      const file = path.join(f.cwd, 'existing.txt');
      const outside = path.join(f.outside, 'new.txt');
      await fs.writeFile(file, '\ufeffbefore\r\n');
      await fs.chmod(file, 0o751);
      const run = await model(f, [
        { name: 'read_file', args: { file_path: file } },
        {
          name: 'edit',
          args: { file_path: file, old_string: 'before', new_string: 'edited' },
        },
        { name: 'write_file', args: { file_path: file, content: 'written\n' } },
        { name: 'write_file', args: { file_path: outside, content: 'denied' } },
      ]);
      completed(run, 4);
      assert.deepEqual(
        await fs.readFile(file),
        Buffer.from('\ufeffwritten\r\n'),
      );
      assert.equal((await fs.stat(file)).mode & 0o777, 0o751);
      assert.equal(await exists(outside), false);
      assert.match(
        toolText(run),
        /read.only|permission denied|EROFS|EPERM|EACCES/i,
      );
      return { fixture: f.dir, byteAndModePreserved: true, outside: false };
    },
  );
  await check(
    'nonbare startup cannot execute repository Git clean filter on host',
    async () => {
      const f = await fixture('git-startup');
      const marker = path.join(f.outside, 'filter-marker');
      const attempt = path.join(f.cwd, 'filter-attempt');
      const file = path.join(f.cwd, 'tracked.txt');
      const git = (...args) => {
        const r = spawnSync('/usr/bin/git', args, {
          cwd: f.cwd,
          env: {
            PATH: testPath,
            HOME: f.home,
            GIT_CONFIG_NOSYSTEM: '1',
          },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, r.stderr);
      };
      git('init', '--quiet');
      await fs.writeFile(file, 'before\n');
      await fs.writeFile(
        path.join(f.cwd, '.gitattributes'),
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
        'fixture',
      );
      git(
        'config',
        '--local',
        'filter.fixture.clean',
        `printf escaped >> ${quote(marker)}; printf attempt >> ${quote(attempt)}; cat`,
      );
      git('config', '--local', 'filter.fixture.required', 'true');
      await fs.writeFile(file, 'after!\n');
      const changedTime = new Date(Date.now() + 5000);
      await fs.utimes(file, changedTime, changedTime);
      const run = await model(f, [
        shellStep('printf SAFE_STARTUP'),
        shellStep('git status --short'),
      ]);
      completed(run, 2);
      assert.equal(await exists(marker), false);
      assert.match(await fs.readFile(attempt, 'utf8'), /^(attempt)+$/);
      assert.match(toolText(run), /Read-only file system|Permission denied/);
      return {
        fixture: f.dir,
        hostFilter: false,
        confinedFilterExercised: true,
      };
    },
  );
  for (const filesystem of ['workspace-write', 'read-only']) {
    await check(
      `project settings migration does not write on host: ${filesystem}`,
      async () => {
        const f = await fixture(`settings-migration-${filesystem}`, {
          tools: { executionSandbox: { ...policy, filesystem } },
        });
        const file = path.join(f.cwd, '.qwen/settings.json');
        const original = Buffer.from(
          '// disposable legacy fixture\n{ "theme": "Default" }\n',
        );
        await fs.writeFile(file, original);
        await fs.chmod(file, 0o600);
        const before = await fs.stat(file, { bigint: true });
        const run = await model(f, []);
        assert.equal(run.code, 0, run.stderr);
        assert.ok(
          run.requests.length > 0,
          'Migration must reach the production model loop',
        );
        assert.deepEqual(await fs.readFile(file), original);
        const after = await fs.stat(file, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.equal(after.mode & 0o777n, 0o600n);
        assert.equal(await exists(file + '.orig'), false);
        assert.equal(await exists(file + '.corrupted'), false);
        return {
          fixture: f.dir,
          filesystem,
          originalBytes: original.toString('hex'),
          unchangedBytesModeAndVersion: true,
        };
      },
    );
    await check(
      `corrupt project settings fail without repair: ${filesystem}`,
      async () => {
        const f = await fixture(`settings-corrupt-${filesystem}`, {
          tools: { executionSandbox: { ...policy, filesystem } },
        });
        const file = path.join(f.cwd, '.qwen/settings.json');
        const original = Buffer.from('{ "broken": ');
        await fs.writeFile(file, original);
        await fs.chmod(file, 0o600);
        const before = await fs.stat(file, { bigint: true });
        const run = await model(f, []);
        assert.notEqual(run.code, 0);
        assert.equal(run.signal, null);
        assert.equal(
          run.requests.length,
          0,
          'Corruption rejection precedes model calls',
        );
        assert.match(run.stderr, /settings|JSON|parse|Unexpected/i);
        assert.deepEqual(await fs.readFile(file), original);
        const after = await fs.stat(file, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.equal(after.mode & 0o777n, 0o600n);
        assert.deepEqual(await fs.readdir(path.dirname(file)), [
          'settings.json',
        ]);
        return {
          fixture: f.dir,
          filesystem,
          code: run.code,
          originalBytes: original.toString('hex'),
          noBackupOrRepair: true,
        };
      },
    );
  }
  await check('public auto selects bwrap', async () =>
    confinement(
      await fixture('auto', {
        tools: { executionSandbox: { ...policy, backend: 'auto' } },
      }),
    ),
  );
  await check('public read-only survives YOLO', async () =>
    confinement(
      await fixture('readonly', {
        tools: { executionSandbox: { ...policy, filesystem: 'read-only' } },
      }),
      { writable: false },
    ),
  );
  await check('public open network applies only when requested', async () =>
    confinement(
      await fixture('open', {
        tools: { executionSandbox: { ...policy, network: 'open' } },
      }),
      { network: true },
    ),
  );
  await check('system complete object overrides user policy', async () =>
    confinement(
      await fixture(
        'system',
        { tools: { executionSandbox: { ...policy, network: 'open' } } },
        {
          tools: {
            executionSandbox: { filesystem: 'read-only', network: 'closed' },
          },
        },
      ),
      { writable: false },
    ),
  );
  await check('system defaults apply without user policy', async () => {
    const f = await fixture('defaults', {});
    await fs.writeFile(
      path.join(f.dir, 'defaults.json'),
      JSON.stringify({ tools: { executionSandbox: policy } }),
    );
    return confinement(f);
  });
  for (const [i, value] of [
    null,
    'malicious',
    [],
    { executionSandbox: false },
    { executionSandbox: null },
    {
      executionSandbox: {
        backend: 'bwrap',
        filesystem: 'workspace-write',
        network: 'open',
      },
    },
  ].entries())
    await check(
      `workspace cannot replace operator tools object ${i}`,
      async () => {
        const f = await fixture(
          `workspace-shadow-${i}`,
          {
            tools: { executionSandbox: { ...policy, filesystem: 'read-only' } },
          },
          {},
          { tools: value },
        );
        return confinement(f, { writable: false });
      },
    );
  await check('workspace-only execution policy is ignored', async () => {
    const f = await fixture(
      'workspace-only',
      {},
      {},
      { tools: { executionSandbox: policy } },
    );
    const outside = path.join(f.outside, 'allowed.txt');
    const run = await model(f, [
      shellStep(`printf ordinary > ${quote(outside)}`),
    ]);
    completed(run, 1);
    assert.equal(await fs.readFile(outside, 'utf8'), 'ordinary');
    assert.match(
      run.stderr,
      /executionSandbox.*ignored|ignored.*executionSandbox/i,
    );
    return { fixture: f.dir, workspaceIgnored: true };
  });
  for (const mode of ['--bare', '--safe-mode'])
    await check(`operator policy survives ${mode}`, async () =>
      confinement(await fixture(`mode-${mode.slice(2)}`), { args: [mode] }),
    );
  for (const [i, value] of [
    false,
    null,
    {},
    { filesystem: 'workspace-write' },
    { ...policy, backend: 'landlock' },
    { ...policy, network: 'proxied' },
    { ...policy, unknown: true },
  ].entries())
    await check(`invalid policy fails before model work ${i}`, async () => {
      const f = await fixture(`invalid-${i}`, {
        tools: { executionSandbox: value },
      });
      const run = await model(f, []);
      assert.notEqual(run.code, 0);
      assert.equal(run.requests.length, 0);
      assert.match(run.stderr, /executionSandbox|sandbox/i);
      return { fixture: f.dir, code: run.code };
    });
  await check(
    'complete policy is not filled from lower priority object',
    async () => {
      const f = await fixture('complete-only', {
        tools: { executionSandbox: { filesystem: 'read-only' } },
      });
      await fs.writeFile(
        path.join(f.dir, 'defaults.json'),
        JSON.stringify({ tools: { executionSandbox: policy } }),
      );
      const run = await model(f, []);
      assert.notEqual(run.code, 0);
      assert.equal(run.requests.length, 0);
      return { fixture: f.dir, code: run.code };
    },
  );
  for (const source of ['argv', 'env', 'settings', 'inherited'])
    await check(
      `legacy ${source} gives migration error before bwrap probe`,
      async () => {
        const f = await fixture(
          `migration-${source}`,
          source === 'settings' ? { tools: { sandbox: 'bwrap' } } : {},
        );
        const env = {
          PATH: `${f.helper}:${testPath}`,
          ...(source === 'env' ? { QWEN_SANDBOX: 'bwrap' } : {}),
          ...(source === 'inherited' ? { SANDBOX: 'bwrap' } : {}),
        };
        const run = await model(
          f,
          [],
          source === 'argv' ? ['--sandbox', 'bwrap'] : [],
          env,
        );
        assert.notEqual(run.code, 0);
        assert.equal(run.requests.length, 0);
        assert.equal(await exists(f.marker), false);
        assert.match(run.stderr, /executionSandbox/);
        return { fixture: f.dir, code: run.code, noProbe: true };
      },
    );
  await check(
    'unavailable bwrap fails without payload or fallback',
    async () => {
      const f = await fixture('unavailable');
      f.maskBwrap = true;
      const outside = path.join(f.outside, 'forbidden.txt');
      const run = await model(
        f,
        [shellStep(`printf escaped > ${quote(outside)}`)],
        [],
        { PATH: `${f.helper}:${testPath}` },
      );
      assert.equal(await exists(outside), false);
      assert.equal(await fs.readFile(f.marker, 'utf8'), 'probe\n');
      assert.notEqual(run.code, 0);
      assert.equal(run.signal, null);
      assert.equal(run.requests.length, 0);
      assert.match(run.stderr, /Sandbox capability probe failed/);
      return { fixture: f.dir, code: run.code, noPayload: true };
    },
  );
  for (const argv of [['--acp'], ['serve']])
    await check(
      `unsupported ${argv[0]} rejects before model or listeners`,
      async () => {
        const f = await fixture(`unsupported-${argv[0].replaceAll('-', '')}`);
        const run = await invoke(f, argv);
        assert.notEqual(run.code, 0);
        assert.equal(run.signal, null, 'Must reject, not time out');
        assert.equal(run.requests.length, 0);
        assert.match(run.stderr, /sandbox/i);
        return { fixture: f.dir, code: run.code };
      },
    );
  for (const option of ['hooks', 'mcp', 'lsp'])
    await check(
      `unsupported startup ${option} has no host sentinel`,
      async () => {
        const f = await fixture(`effect-${option}`);
        const marker = path.join(f.outside, 'host-sentinel');
        const cmd = `printf escaped > ${quote(marker)}`;
        const settings = {
          ...f.settings,
          tools: { executionSandbox: policy },
          ...(option === 'hooks'
            ? {
                hooks: {
                  SessionStart: [
                    { hooks: [{ type: 'command', command: cmd }] },
                  ],
                },
              }
            : {}),
          ...(option === 'mcp'
            ? {
                mcpServers: {
                  sentinel: { command: '/bin/sh', args: ['-c', cmd] },
                },
              }
            : {}),
          ...(option === 'lsp'
            ? { experimental: { lsp: { enabled: true } } }
            : {}),
        };
        await fs.writeFile(
          path.join(f.qwenHome, 'settings.json'),
          JSON.stringify(settings),
        );
        const run = await model(
          f,
          [shellStep('printf SAFE_STARTUP')],
          option === 'lsp' ? ['--experimental-lsp'] : [],
        );
        assert.equal(await exists(marker), false);
        if (run.code !== 0) assert.match(run.stderr, /sandbox/i);
        else assert.match(toolText(run), /SAFE_STARTUP/);
        return { fixture: f.dir, code: run.code, hostSentinel: false };
      },
    );
  await check(
    'sandbox command report and literal argument forwarding',
    async () => {
      const f = await fixture('command');
      const report = await invoke(f, ['sandbox']);
      assert.equal(report.code, 0, report.stderr);
      assert.match(report.stdout, /bwrap/i);
      assert.match(report.stdout, /workspace-write/);
      assert.match(report.stdout, /host/i);
      const argv = ['1e5', '0x10', '--literal', 'space word'];
      const code =
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
      const run = await invoke(f, [
        'sandbox',
        '--',
        binary,
        '-e',
        code,
        ...argv,
      ]);
      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), argv);
      return { fixture: f.dir, report: report.stdout, argv };
    },
  );
  await check('sandbox native verification battery', async () => {
    const f = await fixture('verify');
    const run = await invoke(f, ['sandbox', '--verify']);
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /pass/i);
    return { fixture: f.dir, stdout: run.stdout };
  });
  await check('prompt interpolation shares the sandbox boundary', async () => {
    const f = await fixture('interpolation');
    const inside = path.join(f.cwd, 'inside.txt'),
      outside = path.join(f.outside, 'outside.txt');
    await fs.mkdir(path.join(f.qwenHome, 'commands'));
    const command = `printf interpolation > ${quote(inside)}; printf escaped > ${quote(outside)}; printf INTERPOLATION_RETURNED`;
    await fs.writeFile(
      path.join(f.qwenHome, 'commands/probe.toml'),
      `description = "fixture"\nprompt = """!{${command}}"""\n`,
    );
    const run = await model(f, [], [], {}, '/probe');
    assert.equal(run.code, 0, run.stderr);
    assert.equal(await fs.readFile(inside, 'utf8'), 'interpolation');
    assert.equal(await exists(outside), false);
    assert.match(JSON.stringify(run.requests), /INTERPOLATION_RETURNED/);
    return { fixture: f.dir, inside: true, outside: false };
  });
  for (const scope of ['user', 'project', 'bundled']) {
    for (const filesystem of ['read-only', 'workspace-write']) {
      for (const invocation of ['args', 'bare']) {
        await check(
          `skill ${scope} ${filesystem} ${invocation} refuses before host writes`,
          async () => {
            const f = await fixture(
              `skill-${scope}-${filesystem}-${invocation}`,
              {
                tools: { executionSandbox: { ...policy, filesystem } },
              },
            );
            const skillName =
              scope === 'bundled' ? 'qc-helper' : 'boundary-probe';
            if (scope !== 'bundled') {
              const skillDir = path.join(
                scope === 'user' ? f.qwenHome : path.join(f.cwd, '.qwen'),
                'skills',
                'auto-skill-boundary-probe',
              );
              await fs.mkdir(skillDir, { recursive: true });
              await fs.writeFile(
                path.join(skillDir, 'SKILL.md'),
                '---\nname: boundary-probe\ndescription: Disposable sandbox acceptance fixture\nsource: auto-skill\n---\nSKILL_BOUNDARY_CONTENT. Repeat the supplied argument token.\n',
              );
            }
            const sessionId = '123e4567-e89b-42d3-a456-426614174000';
            const argsPath = path.join(
              f.cwd,
              '.qwen',
              'tmp',
              `s-${sessionId}`,
              `qwen-skill-args-${skillName}.txt`,
            );
            if (invocation === 'bare') {
              await fs.mkdir(path.dirname(argsPath), { recursive: true });
              await fs.writeFile(argsPath, 'PREEXISTING_ARGUMENT_RECORD', {
                mode: 0o600,
              });
            }
            async function snapshot() {
              const result = {};
              for (const file of (await listFiles(f.cwd)).sort()) {
                const st = await fs.stat(file, { bigint: true });
                result[path.relative(f.cwd, file)] = {
                  bytes: (await fs.readFile(file)).toString('base64'),
                  inode: String(st.ino),
                  mode: String(st.mode),
                  mtime: String(st.mtimeNs),
                };
              }
              return result;
            }
            const before = await snapshot();
            f.responseDelay = 300;
            const run = await model(
              f,
              [],
              ['--session-id', sessionId],
              {},
              `/${skillName}${invocation === 'args' ? ' SKILL_ARG_LITERAL' : ''}`,
            );
            const after = await snapshot();
            await fs.writeFile(
              path.join(f.dir, 'workspace-snapshot.json'),
              JSON.stringify({ before, after }, null, 2),
            );
            assert.equal(run.signal, null);
            assert.deepEqual(
              after,
              before,
              'Skill must not create, edit or delete host workspace args/curator files',
            );
            assert.equal(
              run.requests.length,
              0,
              'Rejected skills must not submit a model request',
            );
            assert.match(
              run.stderr + run.stdout,
              /Skill commands are not yet supported with tools\.executionSandbox/,
            );
            return {
              fixture: f.dir,
              code: run.code,
              modelRequests: 0,
              noWorkspaceWrites: true,
              existingArgsPreserved: invocation === 'bare',
            };
          },
        );
      }
    }
  }
  await check('Monitor execution remains confined', async () => {
    const f = await fixture('monitor');
    f.waitForFile = path.join(f.cwd, 'monitor.txt');
    const inside = path.join(f.cwd, 'monitor.txt'),
      outside = path.join(f.outside, 'monitor.txt');
    const run = await model(f, [
      {
        name: 'monitor',
        args: {
          command: `printf monitor > ${quote(inside)}; printf escaped > ${quote(outside)}; echo MONITOR_DONE`,
          description: 'Disposable confinement probe',
          max_events: 1,
          idle_timeout_ms: 1000,
        },
      },
    ]);
    completed(run, 1);
    for (let i = 0; i < 100 && !(await exists(inside)); i++) await delay(20);
    assert.equal(await fs.readFile(inside, 'utf8'), 'monitor');
    assert.equal(await exists(outside), false);
    return { fixture: f.dir, inside: true, outside: false };
  });
  await check('Code Mode nested Shell preserves policy', async () => {
    const f = await fixture('code-mode', {
      tools: { executionSandbox: policy, codeModeOnly: true },
    });
    const inside = path.join(f.cwd, 'code.txt'),
      outside = path.join(f.outside, 'code.txt');
    const command = `printf code-mode > ${quote(inside)}; printf escaped > ${quote(outside)}`;
    const source = `text(await tools.run_shell_command(${JSON.stringify({ command, is_background: false, timeout: 10000 })}));`;
    const run = await model(f, [{ name: 'exec', args: { source } }]);
    completed(run, 1);
    assert.equal(await fs.readFile(inside, 'utf8'), 'code-mode');
    assert.equal(await exists(outside), false);
    return { fixture: f.dir, inside: true, outside: false };
  });

  await check(
    'regular nested agent Shell retains workspace ceiling',
    async () => {
      const f = await fixture('nested-agent');
      const inside = path.join(f.cwd, 'nested.txt'),
        outside = path.join(f.outside, 'nested.txt');
      const steps = [
        {
          name: 'agent',
          args: {
            description: 'Disposable nested confinement probe',
            prompt:
              'NESTED_BOUNDARY: Execute the fixture shell tool then finish.',
            subagent_type: 'general-purpose',
            run_in_background: false,
          },
        },
      ];
      scenarios.set(f.name, {
        steps,
        nestedSteps: [
          shellStep(
            `printf nested > ${quote(inside)}; printf escaped > ${quote(outside)}`,
          ),
        ],
      });
      const run = await invoke(f, [
        ...f.args,
        '--output-format',
        'json',
        '-p',
        'Run the nested fixture',
      ]);
      completed(run, 1);
      assert.ok(
        run.requests.some((r) => r.nested),
        'Must reach an actual nested model request',
      );
      assert.equal(await fs.readFile(inside, 'utf8'), 'nested');
      assert.equal(await exists(outside), false);
      return {
        fixture: f.dir,
        nestedRequests: run.requests.filter((r) => r.nested).length,
        inside: true,
        outside: false,
      };
    },
  );
  for (const renderer of ['ink', 'opentui'])
    await check(
      `public ${renderer} shell and active policy display`,
      async () => {
        const f = await fixture(`tui-${renderer}`);
        const statusMarker = path.join(f.outside, 'status-command');
        await fs.writeFile(
          path.join(f.qwenHome, 'settings.json'),
          JSON.stringify({
            ...f.settings,
            ui: {
              ...f.settings.ui,
              statusLine: {
                type: 'command',
                command: `printf escaped > ${quote(statusMarker)}`,
              },
            },
          }),
        );
        scenarios.set(f.name, { steps: [] });
        const inside = path.join(f.cwd, 'tui-inside.txt'),
          outside = path.join(f.outside, 'tui-outside.txt'),
          nsFile = path.join(f.cwd, 'namespace.txt');
        const socket = `qwen-bwrap-public-${renderer}-${process.pid}`;
        const env = {
          ...f.env,
          QWEN_TUI_RENDERER: renderer,
          ...(renderer === 'opentui' ? { QWEN_TUI_RENDERER_STRICT: '1' } : {}),
        };
        const command = [
          renderer === 'opentui' ? bun : binary,
          installedCli,
          ...f.args,
        ]
          .map(quote)
          .join(' ');
        const t = (args) =>
          spawnSync(tmux, ['-L', socket, ...args], {
            cwd: f.cwd,
            env,
            encoding: 'utf8',
          });
        activeSockets.add(socket);
        assert.equal(
          t([
            'new-session',
            '-d',
            '-s',
            'candidate',
            '-x',
            '160',
            '-y',
            '42',
            command,
          ]).status,
          0,
        );
        let screen = '';
        let themeSelected = false;
        try {
          for (let i = 0; i < 200; i++) {
            screen = t([
              'capture-pane',
              '-p',
              '-S',
              '-150',
              '-t',
              'candidate',
            ]).stdout;
            if (!themeSelected && /Select Theme/.test(screen)) {
              t(['send-keys', '-t', 'candidate', 'Enter']);
              themeSelected = true;
            }
            if (/Type your message|Message Qwen|Send a message/i.test(screen))
              break;
            await delay(200);
          }
          await fs.writeFile(path.join(f.dir, 'startup-screen.txt'), screen);
          assert.match(
            screen,
            /Type your message|Message Qwen|Send a message/i,
            'interactive prompt did not appear',
          );
          assert.match(screen, /bwrap/i, 'UI must show effective backend');
          assert.equal(
            await exists(statusMarker),
            false,
            'Custom status command must not write on host',
          );
          const panePid = Number(
            t([
              'display-message',
              '-p',
              '-t',
              'candidate',
              '#{pane_pid}',
            ]).stdout.trim(),
          );
          async function maps(pid) {
            let value = await fs
              .readFile(`/proc/${pid}/maps`, 'utf8')
              .catch(() => '');
            const children = (
              await fs
                .readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
                .catch(() => '')
            )
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            for (const child of children) value += await maps(Number(child));
            return value;
          }
          const nativeMaps = await maps(panePid);
          if (renderer === 'opentui')
            assert.match(
              nativeMaps,
              /libopentui\.so/,
              'Strict OpenTUI must load its native library',
            );
          else assert.doesNotMatch(nativeMaps, /libopentui\.so/);
          const shell = `!printf tui-${renderer} > ${quote(inside)}; printf escaped > ${quote(outside)}; readlink /proc/self/ns/pid > ${quote(nsFile)}`;
          t(['send-keys', '-t', 'candidate', '-l', shell]);
          await delay(350);
          t(['send-keys', '-t', 'candidate', 'Enter']);
          for (let i = 0; i < 150 && !(await exists(nsFile)); i++)
            await delay(200);
          screen = t([
            'capture-pane',
            '-p',
            '-S',
            '-150',
            '-t',
            'candidate',
          ]).stdout;
          await fs.writeFile(path.join(f.dir, 'final-screen.txt'), screen);
          assert.equal(await fs.readFile(inside, 'utf8'), `tui-${renderer}`);
          assert.equal(await exists(outside), false);
          const ns = (await fs.readFile(nsFile, 'utf8')).trim();
          assert.match(ns, /^pid:\[\d+\]$/);
          assert.notEqual(ns, await fs.readlink('/proc/self/ns/pid'));
          assert.match(
            screen,
            /Read-only\s+file\s+system|Permission\s+denied/i,
          );
          return {
            fixture: f.dir,
            renderer,
            strict: renderer === 'opentui',
            nativeOpenTui: renderer === 'opentui',
            namespace: ns,
            inside: true,
            outside: false,
          };
        } finally {
          t(['kill-server']);
          activeSockets.delete(socket);
        }
      },
    );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.writeFile(
    outputFile,
    JSON.stringify(
      {
        time: new Date().toISOString(),
        root,
        installation,
        version,
        filter,
        results,
        requests,
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
    outputFile,
  }),
);
assert.ok(results.length > 0, 'No public sandbox cases matched');
if (!filter) assert.equal(results.length, 62, 'Unexpected public case count');
process.exitCode = results.every((r) => r.passed) ? 0 : 1;
