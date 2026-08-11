import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  runScenario,
  runScenarios,
  splitCommandLine,
  evaluateSide,
} from '../runner.mjs';
import { extractFlagValues, validateScenario } from '../lib/scenario.mjs';
import { capture, PTY_REFUSAL } from '../lib/capture.mjs';
import { analyzeAnsi } from '../lib/ansi-metrics.mjs';

const EMITTER = [
  'node',
  'scripts/tui-parity/fixtures/emitters/tui-emitter.mjs',
];
const EMITTER_PATH = fileURLToPath(
  new URL('../fixtures/emitters/tui-emitter.mjs', import.meta.url),
);
const HANDSHAKE_PATH = fileURLToPath(
  new URL('../lib/tty-handshake.mjs', import.meta.url),
);
const PTY_LAUNCHER_PATH = fileURLToPath(
  new URL('../fixtures/wrappers/pty-launcher.mjs', import.meta.url),
);

const fixtureCommand = (...flags) => ({
  argv: [...EMITTER, ...flags],
  pty: 'fixture',
});

function scenarioFixture(overrides = {}) {
  return {
    id: 'synthetic',
    description: 'synthetic test scenario',
    terminal: { rows: 6, columns: 30 },
    timeoutMs: 5000,
    commands: {
      base: fixtureCommand('--frames', '2', '--clears-per-frame', '1'),
      fixed: fixtureCommand('--frames', '2', '--sync'),
    },
    thresholds: {
      maxFullScreenClears: 0,
      maxDuplicateEvents: 0,
      requireSync: true,
      requireEventMarkers: true,
    },
    proves: 'synthetic statement of what this proves',
    doesNotProve: 'synthetic statement of what this does not prove',
    ...overrides,
  };
}

async function withWorkdir(fn) {
  const work = await mkdtemp(join(tmpdir(), 'tui-parity-test-'));
  try {
    await fn(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function writeScenario(work, scenario) {
  const file = join(work, `${scenario.id}.scenario.json`);
  await writeFile(file, JSON.stringify(scenario, null, 2));
  return file;
}

test('base fails and fixed passes under shared parameters', async () => {
  await withWorkdir(async (work) => {
    const scenario = validateScenario(scenarioFixture());
    const comparison = await runScenario(scenario, work);
    assert.equal(comparison.outcome, 'base-fails-fixed-passes');
    assert.equal(comparison.harnessPass, true);
    assert.equal(comparison.baseVerdict, 'fail');
    assert.equal(comparison.fixedVerdict, 'pass');
    assert.ok(comparison.deltas.fullScreenClears > 0);
    assert.equal(comparison.compareParams.length, 0);
    const raw = await readFile(
      join(work, 'synthetic', 'base', 'raw.ansi'),
      'utf8',
    );
    // eslint-disable-next-line no-control-regex
    assert.match(raw, /\x1b\[2J/);
    const comparisonFile = JSON.parse(
      await readFile(join(work, 'synthetic', 'comparison.json'), 'utf8'),
    );
    assert.equal(comparisonFile.outcome, 'base-fails-fixed-passes');
    assert.equal(comparisonFile.sides.base.capture.tty.mode, 'fixture');
  });
});

test('capture timeout is a capture error and fails the harness', async () => {
  await withWorkdir(async (work) => {
    const file = await writeScenario(
      work,
      scenarioFixture({
        id: 'hangs',
        timeoutMs: 300,
        commands: {
          base: fixtureCommand('--frames', '1', '--sync'),
          fixed: fixtureCommand('--frames', '1', '--sync', '--hang-ms', '4000'),
        },
      }),
    );
    const result = await runScenarios({
      paths: [file],
      outDir: join(work, 'out-api'),
    });
    assert.equal(result.overall, 'fail');
    assert.equal(result.scenarios[0].outcome, 'capture-error');
    assert.equal(result.scenarios[0].sides.fixed.capture.timedOut, true);
  });
});

test('non-zero fixed exit code fails the fixed side', async () => {
  await withWorkdir(async (work) => {
    const scenario = validateScenario(
      scenarioFixture({
        id: 'bad-exit',
        commands: {
          base: fixtureCommand('--frames', '1', '--sync'),
          fixed: fixtureCommand('--frames', '1', '--sync', '--exit-code', '3'),
        },
      }),
    );
    const comparison = await runScenario(scenario, join(work, 'out'));
    assert.equal(comparison.outcome, 'fixed-fails');
    assert.equal(comparison.harnessPass, false);
    assert.ok(
      comparison.sides.fixed.reasons.some((reason) =>
        reason.includes('exit code 3'),
      ),
    );
  });
});

test('runScenarios fails when fixed exceeds thresholds', async () => {
  await withWorkdir(async (work) => {
    const scenario = scenarioFixture({
      id: 'fixed-violates',
      commands: {
        base: fixtureCommand('--frames', '1', '--sync'),
        fixed: fixtureCommand(
          '--frames',
          '1',
          '--sync',
          '--clears-per-frame',
          '2',
        ),
      },
    });
    const file = await writeScenario(work, scenario);
    const result = await runScenarios({
      paths: [file],
      outDir: join(work, 'out'),
    });
    assert.equal(result.overall, 'fail');
    assert.equal(result.scenarios[0].outcome, 'fixed-fails');
  });
});

test('runScenarios reports validation errors without running', async () => {
  await withWorkdir(async (work) => {
    const scenario = scenarioFixture({ id: 'divergent' });
    scenario.commands.base = {
      ...scenario.commands.base,
      env: { TERM: 'dumb' },
    };
    const file = await writeScenario(work, scenario);
    const result = await runScenarios({
      paths: [file],
      outDir: join(work, 'out'),
    });
    assert.equal(result.overall, 'error');
    assert.ok(result.errors.join(' ').includes('share'));
    assert.equal(result.scenarios.length, 0);
  });
});

test('runScenarios rejects divergent comparison parameters', async () => {
  await withWorkdir(async (work) => {
    const scenario = scenarioFixture({
      id: 'divergent-params',
      compareParams: ['--rows'],
      commands: {
        base: fixtureCommand('--frames', '1', '--sync', '--rows', '6'),
        fixed: fixtureCommand('--frames', '1', '--sync', '--rows', '99'),
      },
    });
    const file = await writeScenario(work, scenario);
    const result = await runScenarios({
      paths: [file],
      outDir: join(work, 'out'),
    });
    assert.equal(result.overall, 'error');
    assert.match(
      result.errors.join(' '),
      /compareParams: "--rows" differs between base \(6\) and fixed \(99\)/,
    );
    assert.equal(result.scenarios.length, 0);
  });
});

test('native TTY command is refused when no PTY backend exists', async () => {
  await withWorkdir(async (work) => {
    const scenario = scenarioFixture({
      id: 'no-pty',
      timeoutMs: 3000,
      commands: {
        base: ['node', '-e', 'process.exit(0)'],
        fixed: fixtureCommand('--frames', '1', '--sync'),
      },
    });
    process.env.TUI_PARITY_NO_PTY = '1';
    try {
      const comparison = await runScenario(
        validateScenario(scenario),
        join(work, 'out'),
      );
      assert.equal(comparison.outcome, 'capture-error');
      assert.equal(comparison.harnessPass, false);
      assert.equal(comparison.sides.base.capture.spawned, false);
      assert.match(
        comparison.sides.base.capture.spawnError,
        /native TTY capture refused/,
      );
      assert.equal(comparison.sides.base.capture.tty.allocated, false);
      assert.equal(comparison.sides.fixed.verdict, 'pass');
    } finally {
      delete process.env.TUI_PARITY_NO_PTY;
    }
  });
});

test('captures are deterministic across runs', async () => {
  await withWorkdir(async (work) => {
    const scenario = validateScenario(scenarioFixture({ id: 'determinism' }));
    const first = await runScenario(scenario, join(work, 'one'));
    const second = await runScenario(scenario, join(work, 'two'));
    assert.equal(first.outcome, 'base-fails-fixed-passes');
    assert.equal(second.outcome, 'base-fails-fixed-passes');
    for (const side of ['base', 'fixed']) {
      const a = await readFile(
        join(work, 'one', 'determinism', side, 'raw.ansi'),
      );
      const b = await readFile(
        join(work, 'two', 'determinism', side, 'raw.ansi'),
      );
      assert.ok(a.equals(b), `${side} capture differs between runs`);
    }
  });
});

test('spawn errors are reported as capture errors', async () => {
  await withWorkdir(async (work) => {
    const scenario = validateScenario(
      scenarioFixture({
        id: 'no-binary',
        commands: {
          base: { argv: ['tui-parity-no-such-binary'], pty: 'fixture' },
          fixed: fixtureCommand('--frames', '1', '--sync'),
        },
      }),
    );
    const comparison = await runScenario(scenario, join(work, 'out'));
    assert.equal(comparison.outcome, 'capture-error');
    assert.equal(comparison.sides.base.capture.spawned, false);
    assert.ok(comparison.sides.base.capture.spawnError);
  });
});

test('splitCommandLine handles quotes and escapes', () => {
  assert.deepEqual(splitCommandLine('node a.mjs --x "two words"'), [
    'node',
    'a.mjs',
    '--x',
    'two words',
  ]);
  assert.deepEqual(splitCommandLine("node 'single quoted' \\space"), [
    'node',
    'single quoted',
    'space',
  ]);
  assert.deepEqual(splitCommandLine('  node   a.mjs  '), ['node', 'a.mjs']);
});

test('native capture allocates a real PTY with TTY evidence', async () => {
  const probe =
    'process.stdout.write(JSON.stringify({isTTY: process.stdout.isTTY, ' +
    'rows: process.stdout.rows, cols: process.stdout.columns}))';
  const cap = await capture([process.execPath, '-e', probe], {
    rows: 12,
    columns: 40,
    timeoutMs: 8000,
    tty: 'native',
  });
  assert.equal(cap.spawned, true, cap.spawnError);
  assert.deepEqual(cap.tty, {
    mode: 'native',
    backend: 'node-pty',
    allocated: true,
    rows: 12,
    columns: 40,
    handshake: null,
  });
  const evidence = JSON.parse(cap.stdoutText.trim());
  assert.equal(evidence.isTTY, true, 'child must see a real TTY');
  assert.equal(evidence.rows, 12);
  assert.equal(evidence.cols, 40);
  assert.equal(cap.exitCode, 0);
  assert.equal(cap.timedOut, false);
});

test('native capture is refused without a PTY backend', async () => {
  process.env.TUI_PARITY_NO_PTY = '1';
  try {
    const cap = await capture([process.execPath, '-e', 'process.exit(0)'], {
      rows: 4,
      columns: 20,
      timeoutMs: 2000,
      tty: 'native',
    });
    assert.equal(cap.spawned, false);
    assert.equal(cap.tty.allocated, false);
    assert.equal(cap.spawnError, PTY_REFUSAL);
    assert.match(cap.spawnError, /native TTY capture refused/);
  } finally {
    delete process.env.TUI_PARITY_NO_PTY;
  }
});

test('wrapped capture verifies the PTY handshake marker', async () => {
  const cap = await capture(
    [
      process.execPath,
      PTY_LAUNCHER_PATH,
      process.execPath,
      HANDSHAKE_PATH,
      process.execPath,
      '-e',
      "process.stdout.write('wrapped-' + process.stdout.isTTY + '\\n')",
    ],
    { rows: 8, columns: 24, timeoutMs: 15000, tty: 'wrapped' },
  );
  assert.equal(
    cap.tty.handshake,
    'verified',
    JSON.stringify({
      handshake: cap.tty.handshake,
      exitCode: cap.exitCode,
      stderr: cap.stderrText.slice(0, 200),
      stdout: cap.stdoutText.slice(0, 200),
    }),
  );
  assert.match(cap.stdoutText, /wrapped-true/);
  assert.equal(cap.exitCode, 0);
});

test('wrapped capture without a real PTY fails the handshake', async () => {
  const cap = await capture(
    [
      process.execPath,
      HANDSHAKE_PATH,
      process.execPath,
      '-e',
      "process.stdout.write('no-tty\\n')",
    ],
    { rows: 4, columns: 20, timeoutMs: 5000, tty: 'wrapped' },
  );
  assert.equal(cap.tty.handshake, 'missing');
  assert.notEqual(cap.exitCode, 0);
  const evalResult = evaluateSide(analyzeAnsi(cap.stdoutText), cap, {});
  assert.equal(evalResult.verdict, 'fail');
  assert.ok(
    evalResult.reasons.some((reason) => reason.includes('handshake')),
    evalResult.reasons.join('; '),
  );
});

test('timeout clears pending input timers and stays bounded', async () => {
  const baselineTimeouts = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
  const started = Date.now();
  const cap = await capture(
    [process.execPath, EMITTER_PATH, '--hang-ms', '30000'],
    {
      rows: 6,
      columns: 30,
      timeoutMs: 300,
      input: [{ data: 'x', delayMs: 5000 }],
      tty: 'fixture',
    },
  );
  assert.equal(cap.timedOut, true);
  assert.ok(
    cap.durationMs < 3000,
    `capture lingered ${cap.durationMs}ms; input timer may be holding it`,
  );
  assert.ok(Date.now() - started < 3000);
  await new Promise((resolve) => setImmediate(resolve));
  const leaked = process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
  assert.ok(
    leaked <= baselineTimeouts,
    `leaked ${leaked - baselineTimeouts} pending timer(s): ` +
      process.getActiveResourcesInfo().join(', '),
  );
});

test('timeout kill reaches child process trees', async () => {
  const cap = await capture([process.execPath, EMITTER_PATH, '--tree-hang'], {
    rows: 4,
    columns: 30,
    timeoutMs: 2000,
    tty: 'fixture',
  });
  assert.equal(cap.timedOut, true);
  const match = /GRANDCHILD=(\d+)/.exec(cap.stdoutText);
  assert.ok(match, `no grandchild pid in capture: ${cap.stdoutText}`);
  const grandchildPid = Number(match[1]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  let alive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `grandchild ${grandchildPid} survived the kill`);
});

test('timeout kill reaches process trees under native PTY capture', async () => {
  const cap = await capture([process.execPath, EMITTER_PATH, '--tree-hang'], {
    rows: 4,
    columns: 30,
    timeoutMs: 2000,
    tty: 'native',
  });
  assert.equal(cap.timedOut, true);
  const match = /GRANDCHILD=(\d+)/.exec(cap.stdoutText);
  assert.ok(match, `no grandchild pid in capture: ${cap.stdoutText}`);
  const grandchildPid = Number(match[1]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  let alive = true;
  try {
    process.kill(grandchildPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `grandchild ${grandchildPid} survived the kill`);
});

test('scripted input is delivered to a fixture capture', async () => {
  const echoCode =
    "let buf='';process.stdin.on('data',(c)=>{buf+=c.toString();" +
    "process.stdout.write('ECHO<'+c.toString()+'>');});" +
    "process.stdin.on('end',()=>process.stdout.write('DONE<'+buf+'>'));";
  const cap = await capture([process.execPath, '-e', echoCode], {
    rows: 6,
    columns: 30,
    timeoutMs: 8000,
    tty: 'fixture',
    input: [
      { data: 'hello', delayMs: 50 },
      { data: 'Q', delayMs: 300 },
    ],
  });
  assert.equal(cap.timedOut, false);
  assert.equal(cap.exitCode, 0, cap.spawnError ?? cap.stdoutText);
  assert.match(cap.stdoutText, /ECHO<hello>/);
  assert.match(cap.stdoutText, /ECHO<Q>/);
  assert.match(cap.stdoutText, /DONE<helloQ>/);
});

test('scripted input is delivered through a native PTY', async () => {
  const echoCode =
    "let buf='';process.stdin.on('data',(c)=>{buf+=c.toString();" +
    "process.stdout.write('ECHO<'+c.toString().trim()+'>');" +
    "if(buf.includes('Q'))setTimeout(()=>process.exit(0),100);});";
  const cap = await capture([process.execPath, '-e', echoCode], {
    rows: 6,
    columns: 30,
    timeoutMs: 8000,
    tty: 'native',
    input: [
      { data: 'hello\r', delayMs: 100 },
      { data: 'Q\r', delayMs: 100 },
    ],
  });
  assert.equal(cap.spawned, true, cap.spawnError);
  assert.equal(cap.timedOut, false);
  assert.equal(cap.exitCode, 0);
  assert.equal(cap.tty.allocated, true);
  assert.match(cap.stdoutText, /ECHO<hello>/);
  assert.match(cap.stdoutText, /ECHO<Q>/);
});

test('requireSync fails when only some frames are bracketed', () => {
  const cap = { spawned: true, timedOut: false, exitCode: 0 };
  const B = '\x1b[?2026h';
  const E = '\x1b[?2026l';
  const marker = (seq) => `\x1b]697;live-line;${seq}\x07`;
  const partial = analyzeAnsi(
    `${B}f1${E}${B}f2${E}f3${marker(1)}${marker(2)}${marker(3)}`,
  );
  const partialEval = evaluateSide(partial, cap, { requireSync: true });
  assert.equal(partialEval.verdict, 'fail');
  assert.ok(
    partialEval.reasons.some((reason) => reason.includes('requireSync')),
    partialEval.reasons.join('; '),
  );
  const full = analyzeAnsi(
    `${B}f1${E}${marker(1)}${B}f2${E}${marker(2)}${B}f3${E}${marker(3)}`,
  );
  assert.equal(evaluateSide(full, cap, { requireSync: true }).verdict, 'pass');
});

test('fixture capture records its waived TTY mode', async () => {
  const cap = await capture([process.execPath, EMITTER_PATH, '--frames', '1'], {
    rows: 6,
    columns: 30,
    timeoutMs: 5000,
    tty: 'fixture',
  });
  assert.equal(cap.spawned, true, cap.spawnError);
  assert.equal(cap.exitCode, 0);
  assert.deepEqual(cap.tty, {
    mode: 'fixture',
    backend: null,
    allocated: false,
    rows: 6,
    columns: 30,
    handshake: null,
  });
});

test('accepts a valid scenario and applies defaults', () => {
  const scenario = validateScenario(scenarioFixture());
  assert.equal(scenario.timeoutMs, 5000);
  assert.deepEqual(scenario.input, []);
  assert.deepEqual(scenario.env, {});
  assert.deepEqual(scenario.compareParams, []);
  assert.equal(scenario.commands.base.pty, 'fixture');
});

test('plain argv commands require native PTY capture', () => {
  const scenario = scenarioFixture();
  scenario.commands.base = ['node', 'base.mjs'];
  scenario.commands.fixed = ['node', 'fixed.mjs'];
  const parsed = validateScenario(scenario);
  assert.equal(parsed.commands.base.pty, 'native');
  assert.equal(parsed.commands.fixed.pty, 'native');
});

test('accepts fixture and wrapped PTY waivers', () => {
  const scenario = scenarioFixture();
  scenario.commands.base = { argv: ['node', 'base.mjs'], pty: 'fixture' };
  scenario.commands.fixed = { argv: ['node', 'fixed.mjs'], pty: 'wrapped' };
  const parsed = validateScenario(scenario);
  assert.equal(parsed.commands.base.pty, 'fixture');
  assert.equal(parsed.commands.fixed.pty, 'wrapped');
});

test('rejects invalid pty modes', () => {
  const scenario = scenarioFixture();
  scenario.commands.base = { argv: ['node', 'base.mjs'], pty: 'pipes' };
  assert.throws(
    () => validateScenario(scenario),
    /commands\.base\.pty must be "fixture" or "wrapped"/,
  );
});

test('rejects per-side parameters on fixed', () => {
  const scenario = scenarioFixture();
  scenario.commands.fixed = {
    argv: ['node', 'fixed.mjs'],
    terminal: { rows: 1, columns: 1 },
  };
  assert.throws(
    () => validateScenario(scenario),
    /base and fixed share all scenario parameters/,
  );
});

test('rejects missing or malformed commands', () => {
  const missing = scenarioFixture();
  delete missing.commands.fixed;
  assert.throws(() => validateScenario(missing), /commands\.fixed is required/);

  const empty = scenarioFixture();
  empty.commands.base = [];
  assert.throws(
    () => validateScenario(empty),
    /commands\.base must be a non-empty array/,
  );

  const missingArgv = scenarioFixture();
  missingArgv.commands.base = { pty: 'fixture' };
  assert.throws(
    () => validateScenario(missingArgv),
    /commands\.base\.argv must be a non-empty array/,
  );
});

test('rejects malformed terminal and timeout', () => {
  const badTerminal = scenarioFixture();
  badTerminal.terminal.rows = 0;
  assert.throws(() => validateScenario(badTerminal), /terminal\.rows/);

  const badTimeout = scenarioFixture();
  badTimeout.timeoutMs = -5;
  assert.throws(() => validateScenario(badTimeout), /timeoutMs/);
});

test('rejects malformed thresholds', () => {
  const negative = scenarioFixture();
  negative.thresholds = { maxFullScreenClears: -1 };
  assert.throws(
    () => validateScenario(negative),
    /thresholds\.maxFullScreenClears/,
  );

  const wrongType = scenarioFixture();
  wrongType.thresholds = { requireSync: 'yes' };
  assert.throws(() => validateScenario(wrongType), /thresholds\.requireSync/);

  const unknown = scenarioFixture();
  unknown.thresholds = { maxEverything: 1 };
  assert.throws(() => validateScenario(unknown), /unknown thresholds key/);
});

test('rejects unknown top-level keys and bad ids', () => {
  const unknownKey = scenarioFixture();
  unknownKey.bonus = true;
  assert.throws(() => validateScenario(unknownKey), /unknown top-level key/);

  const badId = scenarioFixture();
  badId.id = 'Bad Id';
  assert.throws(() => validateScenario(badId), /kebab-case/);
});

test('requires proves and doesNotProve', () => {
  const noProves = scenarioFixture();
  delete noProves.proves;
  assert.throws(() => validateScenario(noProves), /proves is required/);

  const noDoesNotProve = scenarioFixture();
  delete noDoesNotProve.doesNotProve;
  assert.throws(
    () => validateScenario(noDoesNotProve),
    /doesNotProve is required/,
  );
});

test('extractFlagValues normalizes --flag value and --flag=value', () => {
  assert.deepEqual(
    extractFlagValues(
      ['a', '--rows', '12', '--rows=99', '--rowsy', 'x'],
      '--rows',
    ),
    ['12', '99'],
  );
  assert.deepEqual(extractFlagValues(['a'], '--rows'), []);
});

test('rejects divergent rows between sides (compareParams)', () => {
  const scenario = scenarioFixture();
  scenario.terminal = { rows: 12, columns: 30 };
  scenario.compareParams = ['--rows'];
  scenario.commands.base = {
    argv: ['node', 'base.mjs', '--rows', '12'],
    pty: 'fixture',
  };
  scenario.commands.fixed = {
    argv: ['node', 'fixed.mjs', '--rows', '99'],
    pty: 'fixture',
  };
  assert.throws(
    () => validateScenario(scenario),
    /compareParams: "--rows" differs between base \(12\) and fixed \(99\)/,
  );
});

test('rejects divergent columns between sides (compareParams)', () => {
  const scenario = scenarioFixture();
  scenario.compareParams = ['--columns'];
  scenario.commands.base = {
    argv: ['node', 'base.mjs', '--columns', '24'],
    pty: 'fixture',
  };
  scenario.commands.fixed = {
    argv: ['node', 'fixed.mjs', '--columns=36'],
    pty: 'fixture',
  };
  assert.throws(
    () => validateScenario(scenario),
    /compareParams: "--columns" differs between base \(24\) and fixed \(36\)/,
  );
});

test('accepts equal comparison parameters across value spellings', () => {
  const scenario = scenarioFixture();
  scenario.terminal = { rows: 12, columns: 24 };
  scenario.compareParams = ['--rows', '--columns'];
  scenario.commands.base = {
    argv: ['node', 'base.mjs', '--rows', '12', '--columns=24'],
    pty: 'fixture',
  };
  scenario.commands.fixed = {
    argv: ['node', 'fixed.mjs', '--rows=12', '--columns', '24'],
    pty: 'fixture',
  };
  const parsed = validateScenario(scenario);
  assert.deepEqual(parsed.compareParams, ['--rows', '--columns']);
});

test('rejects a comparison parameter missing from one side', () => {
  const scenario = scenarioFixture();
  scenario.compareParams = ['--rows'];
  scenario.commands.base = {
    argv: ['node', 'base.mjs', '--rows', '8'],
    pty: 'fixture',
  };
  scenario.commands.fixed = { argv: ['node', 'fixed.mjs'], pty: 'fixture' };
  assert.throws(
    () => validateScenario(scenario),
    /compareParams: "--rows" is missing from commands\.fixed/,
  );
});

test('rejects comparison parameter values that contradict the terminal', () => {
  const scenario = scenarioFixture();
  scenario.terminal = { rows: 8, columns: 30 };
  scenario.compareParams = ['--rows'];
  scenario.commands.base = {
    argv: ['node', 'base.mjs', '--rows', '12'],
    pty: 'fixture',
  };
  scenario.commands.fixed = {
    argv: ['node', 'fixed.mjs', '--rows', '12'],
    pty: 'fixture',
  };
  assert.throws(
    () => validateScenario(scenario),
    /compareParams: "--rows" value "12" does not match terminal\.rows \(8\)/,
  );
});

test('rejects malformed compareParams entries', () => {
  const scenario = scenarioFixture();
  scenario.compareParams = ['rows'];
  assert.throws(
    () => validateScenario(scenario),
    /compareParams entries must be strings matching --<flag>/,
  );
});
