#!/usr/bin/env node
// End-to-end self-test of the parity harness against its deterministic
// fixtures. Runs both the library API and the CLI, and exits non-zero on
// any failure.
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './runner.mjs';
import { capture, PTY_REFUSAL } from './lib/capture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scenarioPath = join(
  here,
  'fixtures',
  'scenarios',
  'stream-redraw.scenario.json',
);
const launcherPath = join(here, 'fixtures', 'wrappers', 'pty-launcher.mjs');
const handshakePath = join(here, 'lib', 'tty-handshake.mjs');

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`ok - ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL - ${name}${extra === '' ? '' : `: ${extra}`}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function cli(args, cwd) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join(here, 'runner.mjs'), ...args], {
      cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveExit({ code, stdout, stderr }));
  });
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'tui-parity-selftest-'));
  try {
    const outPass = join(work, 'run-pass');
    const pass = await runScenarios({
      paths: [scenarioPath],
      outDir: outPass,
    });
    check(
      'overall pass for committed fixture scenario',
      pass.overall === 'pass',
      pass.overall,
    );
    const comparison = pass.scenarios[0];
    check(
      'outcome is base-fails-fixed-passes',
      comparison?.outcome === 'base-fails-fixed-passes',
      comparison?.outcome,
    );
    check('base verdict fail', comparison?.baseVerdict === 'fail');
    check('fixed verdict pass', comparison?.fixedVerdict === 'pass');
    check(
      'base full-screen clears detected',
      (comparison?.deltas.fullScreenClears ?? 0) > 0,
    );
    check(
      'base duplicate events detected',
      (comparison?.deltas.duplicateEvents ?? 0) > 0,
    );
    check(
      'comparison records the declared comparison parameters',
      JSON.stringify(comparison?.compareParams) ===
        JSON.stringify(['--frames']),
      JSON.stringify(comparison?.compareParams),
    );

    const sideFiles = ['raw.ansi', 'stderr.txt', 'screen.txt', 'summary.json'];
    for (const side of ['base', 'fixed']) {
      for (const name of sideFiles) {
        check(
          `artifact ${side}/${name} exists`,
          await fileExists(join(outPass, 'stream-redraw', side, name)),
        );
      }
    }
    for (const name of ['comparison.json', 'report.md']) {
      check(
        `artifact stream-redraw/${name} exists`,
        await fileExists(join(outPass, 'stream-redraw', name)),
      );
    }
    check(
      'artifact run-summary.json exists',
      await fileExists(join(outPass, 'run-summary.json')),
    );

    const comparisonFile = await readJson(
      join(outPass, 'stream-redraw', 'comparison.json'),
    );
    check(
      'comparison states what the scenario proves',
      typeof comparisonFile.proves === 'string' &&
        comparisonFile.proves.length > 0,
    );
    check(
      'comparison states what the scenario does not prove',
      typeof comparisonFile.doesNotProve === 'string' &&
        comparisonFile.doesNotProve.length > 0,
    );
    const baseSummary = await readJson(
      join(outPass, 'stream-redraw', 'base', 'summary.json'),
    );
    check(
      'base side metrics recorded',
      baseSummary.metrics.fullScreenClears.total >= 3,
    );
    check(
      'fixture capture records its waived TTY mode',
      baseSummary.capture.tty?.mode === 'fixture' &&
        baseSummary.capture.tty?.allocated === false,
      JSON.stringify(baseSummary.capture.tty),
    );
    const fixedScreen = await readFile(
      join(outPass, 'stream-redraw', 'fixed', 'screen.txt'),
      'utf8',
    );
    check(
      'fixed final screen shows last frame',
      fixedScreen.includes('frame=3'),
    );

    const outDeterminism = join(work, 'run-determinism');
    await runScenarios({ paths: [scenarioPath], outDir: outDeterminism });
    for (const side of ['base', 'fixed']) {
      const first = await readFile(
        join(outPass, 'stream-redraw', side, 'raw.ansi'),
      );
      const second = await readFile(
        join(outDeterminism, 'stream-redraw', side, 'raw.ansi'),
      );
      check(`deterministic ${side} capture`, first.equals(second));
    }

    const nativeProbe =
      'process.stdout.write(JSON.stringify({isTTY: process.stdout.isTTY, ' +
      'rows: process.stdout.rows}))';
    const nativeCap = await capture([process.execPath, '-e', nativeProbe], {
      rows: 8,
      columns: 24,
      timeoutMs: 8000,
      tty: 'native',
    });
    check('native PTY capture allocates a real TTY', nativeCap.tty.allocated);
    check(
      'child under native capture sees isTTY=true with scenario rows',
      /"isTTY":true/.test(nativeCap.stdoutText) &&
        /"rows":8/.test(nativeCap.stdoutText),
      nativeCap.stdoutText,
    );

    process.env.TUI_PARITY_NO_PTY = '1';
    let refusedCap;
    try {
      refusedCap = await capture([process.execPath, '-e', nativeProbe], {
        rows: 8,
        columns: 24,
        timeoutMs: 2000,
        tty: 'native',
      });
    } finally {
      delete process.env.TUI_PARITY_NO_PTY;
    }
    check(
      'native capture is refused without a PTY backend',
      refusedCap.spawned === false && refusedCap.spawnError === PTY_REFUSAL,
      refusedCap.spawnError,
    );

    const wrappedCap = await capture(
      [
        process.execPath,
        launcherPath,
        process.execPath,
        handshakePath,
        process.execPath,
        '-e',
        "process.stdout.write('wrapped-' + process.stdout.isTTY + '\\n')",
      ],
      { rows: 8, columns: 24, timeoutMs: 15000, tty: 'wrapped' },
    );
    check(
      'wrapped capture verifies the PTY handshake inside a real PTY',
      wrappedCap.tty.handshake === 'verified' &&
        /wrapped-true/.test(wrappedCap.stdoutText),
      JSON.stringify({
        handshake: wrappedCap.tty.handshake,
        stdout: wrappedCap.stdoutText.slice(0, 120),
      }),
    );

    const divergedFixture = await readJson(scenarioPath);
    divergedFixture.id = 'fixed-violates';
    divergedFixture.commands.fixed = {
      ...divergedFixture.commands.fixed,
      argv: [...divergedFixture.commands.fixed.argv, '--clears-per-frame', '2'],
    };
    const violatesPath = join(work, 'fixed-violates.scenario.json');
    await writeFile(violatesPath, JSON.stringify(divergedFixture, null, 2));
    const violates = await runScenarios({
      paths: [violatesPath],
      outDir: join(work, 'run-fixed-violates'),
    });
    check(
      'overall fail when fixed exceeds thresholds',
      violates.overall === 'fail',
      violates.overall,
    );
    check(
      'outcome is fixed-fails',
      violates.scenarios[0]?.outcome === 'fixed-fails',
      violates.scenarios[0]?.outcome,
    );

    const divergedParams = await readJson(scenarioPath);
    divergedParams.id = 'diverged-params';
    divergedParams.commands.base = {
      ...divergedParams.commands.base,
      env: { FORCE_COLOR: '0' },
    };
    const divergedPath = join(work, 'diverged-params.scenario.json');
    await writeFile(divergedPath, JSON.stringify(divergedParams, null, 2));
    const diverged = await runScenarios({
      paths: [divergedPath],
      outDir: join(work, 'run-diverged-params'),
    });
    check(
      'divergent per-side parameters are an error',
      diverged.overall === 'error',
      diverged.overall,
    );
    check(
      'error names the shared-parameter contract',
      diverged.errors.join(' ').includes('share'),
      diverged.errors.join(' '),
    );

    const divergedRows = await readJson(scenarioPath);
    divergedRows.id = 'diverged-rows';
    divergedRows.compareParams = ['--frames', '--rows'];
    divergedRows.commands.base = {
      ...divergedRows.commands.base,
      argv: [...divergedRows.commands.base.argv, '--rows', '12'],
    };
    divergedRows.commands.fixed = {
      ...divergedRows.commands.fixed,
      argv: [...divergedRows.commands.fixed.argv, '--rows', '99'],
    };
    const divergedRowsPath = join(work, 'diverged-rows.scenario.json');
    await writeFile(divergedRowsPath, JSON.stringify(divergedRows, null, 2));
    const divergedRowsRun = await runScenarios({
      paths: [divergedRowsPath],
      outDir: join(work, 'run-diverged-rows'),
    });
    check(
      'divergent --rows comparison parameters are an error',
      divergedRowsRun.overall === 'error',
      divergedRowsRun.overall,
    );
    check(
      'error names the differing rows values',
      divergedRowsRun.errors.join(' ').includes('"--rows" differs'),
      divergedRowsRun.errors.join(' '),
    );

    check(
      'cli exits 0 for the passing fixture scenario',
      (
        await cli(
          ['--scenario', scenarioPath, '--out', join(work, 'cli-pass')],
          repoRoot,
        )
      ).code === 0,
    );
    check(
      'cli exits 1 when fixed exceeds thresholds',
      (
        await cli(
          ['--scenario', violatesPath, '--out', join(work, 'cli-fail')],
          repoRoot,
        )
      ).code === 1,
    );
    check(
      'cli exits 2 for missing arguments',
      (await cli(['--scenario', scenarioPath], repoRoot)).code === 2,
    );
    const overridesDir = join(work, 'cli-overrides');
    await mkdir(overridesDir, { recursive: true });
    const emitterCmd = (flags) =>
      `"${process.execPath}" ` +
      `scripts/tui-parity/fixtures/emitters/tui-emitter.mjs ${flags}`;
    const overrideCode = await cli(
      [
        '--scenario',
        scenarioPath,
        '--out',
        overridesDir,
        '--base',
        emitterCmd('--frames 1 --sync'),
        '--fixed',
        emitterCmd('--frames 1 --sync'),
      ],
      repoRoot,
    );
    const overrideSummary = await readJson(
      join(overridesDir, 'run-summary.json'),
    );
    check(
      'cli command overrides run through native PTY capture',
      overrideCode.code === 0,
    );
    check(
      'cli override outcome is both-pass',
      overrideSummary.scenarios[0]?.outcome === 'both-pass',
      JSON.stringify(overrideSummary.scenarios),
    );
    const overrideBaseSummary = await readJson(
      join(overridesDir, 'stream-redraw', 'base', 'summary.json'),
    );
    check(
      'cli override capture records native PTY evidence',
      overrideBaseSummary.capture.tty?.mode === 'native' &&
        overrideBaseSummary.capture.tty?.allocated === true,
      JSON.stringify(overrideBaseSummary.capture.tty),
    );

    // Adversarial counterexample: scenario validation saw equal compareParams,
    // but the overrides diverge. The final resolved argv must be re-validated
    // after overrides, so the run must abort before anything is captured.
    const divergentOverride = await cli(
      [
        '--scenario',
        scenarioPath,
        '--out',
        join(work, 'cli-override-divergent'),
        '--base',
        emitterCmd('--frames 1 --sync'),
        '--fixed',
        emitterCmd('--frames 4 --sync'),
      ],
      repoRoot,
    );
    check(
      'cli override diverging from compareParams exits 2',
      divergentOverride.code === 2,
      `code=${divergentOverride.code} stderr=${divergentOverride.stderr}`,
    );
    check(
      'cli override mismatch names parameter binding on the final argv',
      divergentOverride.stderr.includes('parameter binding') &&
        divergentOverride.stderr.includes('"--frames" differs'),
      divergentOverride.stderr,
    );
    check(
      'cli override mismatch runs nothing',
      !(await fileExists(
        join(
          work,
          'cli-override-divergent',
          'stream-redraw',
          'base',
          'raw.ansi',
        ),
      )),
    );

    const dimensionOverride = await cli(
      [
        '--scenario',
        scenarioPath,
        '--out',
        join(work, 'cli-override-dimension'),
        '--base',
        emitterCmd('--frames 3 --sync --rows 99'),
      ],
      repoRoot,
    );
    check(
      'cli override with a mismatched terminal-size flag exits 2',
      dimensionOverride.code === 2,
      `code=${dimensionOverride.code} stderr=${dimensionOverride.stderr}`,
    );
    check(
      'cli override dimension mismatch names the capture geometry',
      dimensionOverride.stderr.includes('"--rows" value "99"') &&
        dimensionOverride.stderr.includes('terminal.rows'),
      dimensionOverride.stderr,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`self-test: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('self-test: all checks passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
