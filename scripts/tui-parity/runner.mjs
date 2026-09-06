#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeAnsi } from './lib/ansi-metrics.mjs';
import { capture } from './lib/capture.mjs';
import { renderFinalScreen } from './lib/normalize.mjs';
import {
  loadScenarios,
  validateCompareParams,
  validateTerminalFlags,
} from './lib/scenario.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveCommand(argv) {
  const out = [...argv];
  if (
    out.length >= 2 &&
    out[0] === 'node' &&
    !isAbsolute(out[1]) &&
    /\.(mjs|cjs|js)$/.test(out[1])
  ) {
    out[1] = resolve(REPO_ROOT, out[1]);
  }
  return out;
}

export function splitCommandLine(text) {
  const parts = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += text[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) parts.push(current);
  return parts;
}

// Re-validates the commands that will actually execute, AFTER any
// --base/--fixed overrides have replaced the scenario commands. Scenario-load
// validation only saw the original scenario argv; a divergent override would
// otherwise run while the report still claimed the compareParams were checked.
// Throws before anything is captured.
export function validateFinalParams(
  scenario,
  baseCommand,
  fixedCommand,
  overrides = {},
) {
  const problems = [];
  const compareParams = scenario.compareParams ?? [];
  const baseArgv = resolveCommand(baseCommand.argv);
  const fixedArgv = resolveCommand(fixedCommand.argv);
  if (compareParams.length > 0) {
    validateCompareParams(
      compareParams,
      { argv: baseArgv },
      { argv: fixedArgv },
      scenario.terminal,
      problems,
    );
  }
  validateTerminalFlags(baseArgv, scenario.terminal, 'commands.base', problems);
  validateTerminalFlags(
    fixedArgv,
    scenario.terminal,
    'commands.fixed',
    problems,
  );
  if (problems.length > 0) {
    const overridden = ['base', 'fixed']
      .filter((side) => overrides[side])
      .map((side) => `--${side}`);
    const subject =
      overridden.length > 0
        ? `${overridden.join(' and ')} override(s)`
        : 'the final command';
    throw new Error(
      `${subject} failed parameter binding on the final resolved argv: ` +
        problems.join('; '),
    );
  }
}

export const METRIC_VIEWS = {
  fullScreenClears: (met) => met.fullScreenClears.total,
  partialScreenErases: (met) => met.partialScreenErases,
  lineErases: (met) => met.lineErases.total,
  dec2026Unbalanced: (met) => met.dec2026.unbalanced,
  duplicateEvents: (met) => met.events.duplicates,
  eventMarkers: (met) => met.events.total,
  unwrappedEvents: (met) => met.events.unwrapped,
  printableChars: (met) => met.printableChars,
  stdoutBytes: (met) => met.bytes,
};

export function evaluateSide(metrics, cap, thresholds = {}) {
  const reasons = [];
  const check = (name, value, max) => {
    if (max !== undefined && value > max) {
      reasons.push(`${name}=${value} exceeds threshold max ${max}`);
    }
  };
  if (cap.spawnError) reasons.push(`spawn failed: ${cap.spawnError}`);
  if (cap.timedOut) reasons.push(`timed out after ${cap.timeoutMs}ms`);
  if (cap.tty?.mode === 'wrapped' && cap.tty.handshake !== 'verified') {
    reasons.push(
      'PTY wrapper handshake not verified: captured stdout contains no ' +
        "tty-handshake OSC 697 marker with this run's nonce, so native TTY " +
        'capture is not proven for this side',
    );
  }
  if ((thresholds.requireExitCodeZero ?? true) && cap.exitCode !== 0) {
    reasons.push(`exit code ${cap.exitCode ?? 'null'} != 0`);
  }
  check(
    'fullScreenClears',
    metrics.fullScreenClears.total,
    thresholds.maxFullScreenClears,
  );
  check('lineErases', metrics.lineErases.total, thresholds.maxLineErases);
  check(
    'partialScreenErases',
    metrics.partialScreenErases,
    thresholds.maxPartialScreenErases,
  );
  check(
    'duplicateEvents',
    metrics.events.duplicates,
    thresholds.maxDuplicateEvents,
  );
  check(
    'dec2026Unbalanced',
    metrics.dec2026.unbalanced,
    thresholds.maxDec2026Unbalanced,
  );
  if (thresholds.requireSync) {
    if (metrics.dec2026.begin === 0) {
      reasons.push('requireSync: no DEC 2026 begin sequence found');
    }
    if (metrics.dec2026.unbalanced !== 0) {
      reasons.push(
        `requireSync: DEC 2026 pairs unbalanced by ${metrics.dec2026.unbalanced}`,
      );
    }
    // Coverage is measured per event occurrence: a marker only counts as
    // synced when it was emitted inside an active DEC 2026 interval. Empty
    // begin/end pairs and unwrapped markers can never prove coverage, even
    // when the begin count matches the unique event count.
    if (metrics.events.markersPresent && metrics.events.unwrapped > 0) {
      reasons.push(
        `requireSync: ${metrics.events.unwrapped} live-output event ` +
          'marker(s) were emitted outside any DEC 2026 sync interval; sync ' +
          'brackets must wrap every measured event',
      );
    }
  }
  if (thresholds.requireEventMarkers && !metrics.events.markersPresent) {
    reasons.push('requireEventMarkers: no OSC 697 event markers found');
  }
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons };
}

const PASSING_OUTCOMES = new Set(['base-fails-fixed-passes', 'both-pass']);

export function buildComparison(
  scenario,
  base,
  fixed,
  generatedAt,
  overridesApplied = { base: false, fixed: false },
) {
  const captureOk = (side) => side.capture.spawned && !side.capture.timedOut;
  let outcome;
  if (!captureOk(base) || !captureOk(fixed)) outcome = 'capture-error';
  else if (fixed.eval.verdict === 'fail') outcome = 'fixed-fails';
  else if (base.eval.verdict === 'fail') outcome = 'base-fails-fixed-passes';
  else outcome = 'both-pass';
  const deltas = {};
  for (const [key, view] of Object.entries(METRIC_VIEWS)) {
    deltas[key] = view(base.metrics) - view(fixed.metrics);
  }
  return {
    scenarioId: scenario.id,
    description: scenario.description,
    generatedAt,
    terminal: scenario.terminal,
    timeoutMs: scenario.timeoutMs,
    compareParams: scenario.compareParams ?? [],
    overridesApplied,
    commands: { base: base.command, fixed: fixed.command },
    sides: {
      base: summarizeSide(base),
      fixed: summarizeSide(fixed),
    },
    baseVerdict: base.eval.verdict,
    fixedVerdict: fixed.eval.verdict,
    deltas,
    outcome,
    expectBaseFailure: scenario.expectBaseFailure === true,
    // A scenario whose base side is a defect fixture proves nothing when the
    // base passes: both-pass there means the fixture lost its defect, not that
    // the fixed side matched a clean reference.
    harnessPass:
      PASSING_OUTCOMES.has(outcome) &&
      !(scenario.expectBaseFailure === true && outcome === 'both-pass'),
    proves: scenario.proves,
    doesNotProve: scenario.doesNotProve,
  };
}

function summarizeSide(side) {
  const cap = side.capture;
  return {
    command: side.command,
    capture: {
      spawned: cap.spawned,
      spawnError: cap.spawnError,
      exitCode: cap.exitCode,
      signal: cap.signal,
      timedOut: cap.timedOut,
      timeoutMs: cap.timeoutMs,
      durationMs: cap.durationMs,
      stdoutBytes: cap.stdoutBytes,
      stderrBytes: cap.stderrBytes,
      tty: cap.tty,
    },
    metrics: side.metrics,
    screen: side.screen,
    verdict: side.eval.verdict,
    reasons: side.eval.reasons,
  };
}

function describeTty(tty) {
  if (!tty) return 'unknown';
  if (tty.mode === 'native') {
    return tty.allocated
      ? `native PTY (${tty.backend}, ${tty.rows}x${tty.columns})`
      : 'native PTY refused (no backend)';
  }
  if (tty.mode === 'wrapped') return `wrapped (handshake ${tty.handshake})`;
  return 'fixture (pipe capture, TTY waived)';
}

export function renderReport(comparison) {
  const c = comparison;
  const lines = [];
  lines.push(`# TUI parity report: ${c.scenarioId}`);
  lines.push('');
  lines.push(c.description);
  lines.push('');
  lines.push(`- Generated: ${c.generatedAt}`);
  lines.push(
    `- Terminal: ${c.terminal.rows} rows x ${c.terminal.columns} columns, timeout ${c.timeoutMs}ms`,
  );
  lines.push(
    `- Outcome: **${c.outcome}** (base=${c.baseVerdict}, fixed=${c.fixedVerdict})`,
  );
  if (c.expectBaseFailure) {
    lines.push(
      c.outcome === 'both-pass'
        ? '- Gate: **failed** — this scenario requires the base side to fail, so ' +
            'a both-pass means the base fixture emitted no defect and the ' +
            'comparison proves nothing.'
        : '- Gate: this scenario requires the base side to fail (its base is a ' +
            'defect fixture, so a clean base proves nothing).',
    );
  }
  lines.push('');
  lines.push('## Commands');
  lines.push('');
  lines.push(`- base: \`${c.commands.base.join(' ')}\``);
  lines.push(`- fixed: \`${c.commands.fixed.join(' ')}\``);
  const overriddenSides = ['base', 'fixed'].filter(
    (side) => c.overridesApplied?.[side],
  );
  if (overriddenSides.length > 0) {
    lines.push(
      `- Overrides applied to: ${overriddenSides.join(', ')}. Final resolved ` +
        'commands were re-validated for compareParams and terminal dimensions ' +
        'after the override, before capture.',
    );
  }
  if (c.compareParams.length > 0) {
    lines.push(
      `- Declared comparison parameters (validated equal on the final commands that ran): ${c.compareParams.join(' ')}`,
    );
  }
  lines.push(
    `- Capture: base ${describeTty(c.sides.base.capture.tty)}, fixed ${describeTty(c.sides.fixed.capture.tty)}`,
  );
  lines.push('');
  lines.push('## Metrics (stdout)');
  lines.push('');
  lines.push('| metric | base | fixed | delta (base-fixed) |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [key, view] of Object.entries(METRIC_VIEWS)) {
    lines.push(
      `| ${key} | ${view(c.sides.base.metrics)} | ${view(c.sides.fixed.metrics)} | ${c.deltas[key]} |`,
    );
  }
  lines.push('');
  lines.push('## Thresholds (fixed side)');
  lines.push('');
  if (c.sides.fixed.verdict === 'pass') {
    lines.push('All configured fixed-side thresholds satisfied.');
  } else {
    for (const reason of c.sides.fixed.reasons) {
      lines.push(`- VIOLATED: ${reason}`);
    }
  }
  if (c.sides.base.reasons.length > 0) {
    lines.push('');
    lines.push('Base-side observations:');
    for (const reason of c.sides.base.reasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push('');
  lines.push('## What this scenario proves');
  lines.push('');
  lines.push(c.proves);
  lines.push('');
  lines.push('## What this scenario does not prove');
  lines.push('');
  lines.push(c.doesNotProve);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  const sideFiles = ['raw.ansi', 'stderr.txt', 'screen.txt', 'summary.json'];
  for (const side of ['base', 'fixed']) {
    for (const name of sideFiles) {
      lines.push(`- ${side}/${name}`);
    }
  }
  lines.push('- comparison.json');
  lines.push('- report.md');
  lines.push('');
  return lines.join('\n');
}

async function writeSide(dir, summary, rawText, stderrText, screen) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'raw.ansi'), rawText);
  await writeFile(join(dir, 'stderr.txt'), stderrText);
  await writeFile(join(dir, 'screen.txt'), screen === '' ? '' : `${screen}\n`);
  await writeFile(
    join(dir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

async function runSide(scenario, sideName, command, scenarioDir) {
  const resolved = resolveCommand(command.argv);
  const cap = await capture(resolved, {
    rows: scenario.terminal.rows,
    columns: scenario.terminal.columns,
    timeoutMs: scenario.timeoutMs,
    input: scenario.input,
    env: scenario.env,
    tty: command.pty,
  });
  const metrics = analyzeAnsi(cap.stdoutText);
  const screen = renderFinalScreen(cap.stdoutText, {
    rows: scenario.terminal.rows,
    columns: scenario.terminal.columns,
  });
  const evalResult = evaluateSide(metrics, cap, scenario.thresholds);
  await writeSide(
    join(scenarioDir, sideName),
    {
      scenarioId: scenario.id,
      side: sideName,
      command: resolved,
      capture: {
        spawned: cap.spawned,
        spawnError: cap.spawnError,
        exitCode: cap.exitCode,
        signal: cap.signal,
        timedOut: cap.timedOut,
        timeoutMs: cap.timeoutMs,
        durationMs: cap.durationMs,
        stdoutBytes: cap.stdoutBytes,
        stderrBytes: cap.stderrBytes,
        tty: cap.tty,
      },
      metrics,
      verdict: evalResult.verdict,
      reasons: evalResult.reasons,
    },
    cap.stdoutText,
    cap.stderrText,
    screen,
  );
  return { command: resolved, capture: cap, metrics, screen, eval: evalResult };
}

export async function runScenario(scenario, outDir, overrides = {}) {
  const scenarioDir = join(outDir, scenario.id);
  const generatedAt = new Date().toISOString();
  const wrapOverride = (argv) => (argv ? { argv, pty: 'native' } : undefined);
  const baseCommand = wrapOverride(overrides.base) ?? scenario.commands.base;
  const fixedCommand = wrapOverride(overrides.fixed) ?? scenario.commands.fixed;
  validateFinalParams(scenario, baseCommand, fixedCommand, overrides);
  const base = await runSide(scenario, 'base', baseCommand, scenarioDir);
  const fixed = await runSide(scenario, 'fixed', fixedCommand, scenarioDir);
  const comparison = buildComparison(scenario, base, fixed, generatedAt, {
    base: Boolean(overrides.base),
    fixed: Boolean(overrides.fixed),
  });
  await writeFile(
    join(scenarioDir, 'comparison.json'),
    `${JSON.stringify(comparison, null, 2)}\n`,
  );
  await writeFile(join(scenarioDir, 'report.md'), renderReport(comparison));
  return comparison;
}

export async function runScenarios({
  paths,
  outDir,
  baseOverride,
  fixedOverride,
}) {
  const errors = [];
  let entries;
  try {
    entries = await loadScenarios(paths);
  } catch (err) {
    errors.push(err.message);
    entries = [];
  }
  const results = [];
  for (const entry of entries) {
    try {
      results.push(
        await runScenario(entry.scenario, outDir, {
          base: baseOverride,
          fixed: fixedOverride,
        }),
      );
    } catch (err) {
      errors.push(`${entry.file}: ${err.message}`);
    }
  }
  const overall =
    errors.length > 0
      ? 'error'
      : results.length > 0 && results.every((c) => c.harnessPass)
        ? 'pass'
        : 'fail';
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, 'run-summary.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        overall,
        errors,
        scenarios: results.map((c) => ({
          scenarioId: c.scenarioId,
          outcome: c.outcome,
          baseVerdict: c.baseVerdict,
          fixedVerdict: c.fixedVerdict,
          proves: c.proves,
          doesNotProve: c.doesNotProve,
        })),
      },
      null,
      2,
    )}\n`,
  );
  return { overall, scenarios: results, errors };
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/tui-parity/runner.mjs --scenario <file|dir> [...] --out <dir>',
      '',
      'Options:',
      '  --scenario <path>  Scenario JSON file, or a directory containing',
      '                     *.scenario.json files. Repeatable.',
      '  --out <dir>        Artifact output directory.',
      '  --base <command>   Override the base command (single scenario only).',
      '  --fixed <command>  Override the fixed command (single scenario only).',
      '  --help             Show this help.',
      '',
      'Commands are captured through a native PTY (the real-CLI contract).',
      'A scenario may waive the PTY for deterministic fixtures ("pty":',
      '"fixture") or prove a caller-supplied PTY wrapper via the',
      'tty-handshake ("pty": "wrapped").',
      '',
      'Exit codes: 0 all scenarios pass, 1 threshold/capture failure,',
      '            2 usage or validation error.',
    ].join('\n'),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const opts = { scenarios: [], out: null, base: null, fixed: null };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      printUsage();
      return 0;
    }
    const nextValue = () => {
      const value = args[++i];
      if (value === undefined) {
        throw new Error(`missing value for ${flag}`);
      }
      return value;
    };
    if (flag === '--scenario') opts.scenarios.push(nextValue());
    else if (flag === '--out') opts.out = nextValue();
    else if (flag === '--base') opts.base = splitCommandLine(nextValue());
    else if (flag === '--fixed') opts.fixed = splitCommandLine(nextValue());
    else {
      console.error(`unknown argument: ${flag}`);
      printUsage();
      return 2;
    }
  }
  if (opts.scenarios.length === 0 || opts.out === null) {
    console.error('--scenario and --out are required');
    printUsage();
    return 2;
  }
  if ((opts.base || opts.fixed) && opts.scenarios.length > 1) {
    console.error('--base/--fixed overrides apply to a single --scenario only');
    return 2;
  }
  if (opts.base && opts.base.length === 0) {
    console.error('--base command is empty');
    return 2;
  }
  if (opts.fixed && opts.fixed.length === 0) {
    console.error('--fixed command is empty');
    return 2;
  }
  const result = await runScenarios({
    paths: opts.scenarios,
    outDir: opts.out,
    baseOverride: opts.base,
    fixedOverride: opts.fixed,
  });
  for (const error of result.errors) console.error(`error: ${error}`);
  for (const c of result.scenarios) {
    const gate =
      c.expectBaseFailure && c.outcome === 'both-pass'
        ? ' (requires a failing base: the base fixture emitted no defect)'
        : '';
    console.log(
      `${c.scenarioId}: outcome=${c.outcome} base=${c.baseVerdict} fixed=${c.fixedVerdict}${gate}`,
    );
  }
  console.log(`overall: ${result.overall}`);
  if (result.overall === 'pass') return 0;
  if (result.overall === 'fail') return 1;
  return 2;
}

const isMainEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    },
  );
}
