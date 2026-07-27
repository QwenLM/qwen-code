/**
 * Functional scenario matrix for PR #7767 against real ACP children.
 * Each scenario runs both bundles and prints a pass/fail line.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const CONTROL = path.resolve(arg('control'));
const CANDIDATE = path.resolve(arg('candidate'));
const REPEATS = Number(arg('repeats', '3'));

async function probe(bundle, extra) {
  const variant = bundle === CONTROL ? 'control' : 'candidate';
  const args = [
    path.join(__dirname, 'acp-probe.mjs'),
    '--bundle',
    bundle,
    '--compile-cache',
    path.join(__dirname, '.compile-cache', variant),
    ...extra,
  ];
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    stdout = String(e.stdout ?? '');
  }
  const line = stdout.split('\n').find((l) => l.startsWith('@@SAMPLE@@'));
  return line ? JSON.parse(line.slice('@@SAMPLE@@'.length)) : { ok: false };
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};

const stripVolatile = (o) =>
  JSON.parse(
    JSON.stringify(o, (k, v) => (k === 'sessionId' ? '<id>' : v)),
  );

const run = async () => {
  // --- S1: session/new response shape is byte-identical across variants ----
  {
    const c = await probe(CONTROL, ['--mode', 'idle', '--dwell', '300']);
    const k = await probe(CANDIDATE, ['--mode', 'idle', '--dwell', '300']);
    const a = JSON.stringify(stripVolatile(c.newSessionResult));
    const b = JSON.stringify(stripVolatile(k.newSessionResult));
    record(
      'S1 session/new response shape unchanged',
      a === b && a.length > 100,
      `${a.length} bytes, identical=${a === b}`,
    );
    const ia = JSON.stringify(c.initializeResult);
    const ib = JSON.stringify(k.initializeResult);
    record(
      'S1b initialize response unchanged',
      ia === ib && ia.length > 100,
      `${ia.length} bytes, identical=${ia === ib}`,
    );
  }

  // --- S2: a prepared-but-never-prompted session issues no model request ---
  {
    const rows = [];
    let pass = true;
    for (const [name, bundle] of [
      ['control', CONTROL],
      ['candidate', CANDIDATE],
    ]) {
      for (let i = 0; i < REPEATS; i++) {
        const s = await probe(bundle, ['--mode', 'idle', '--dwell', '2000']);
        const ok =
          s.ok &&
          s.gates.providerRequestsDuringPreloadWindow === 0 &&
          s.gates.providerRequestsAtSessionReady === 0 &&
          s.childExitCode === 0 &&
          !s.gates.unhandledRejection;
        pass &&= ok;
        rows.push(`${name}#${i}: req=${s.gates?.providerRequestsDuringPreloadWindow} exit=${s.childExitCode} rss=${(s.rssKib / 1024).toFixed(0)}MiB`);
      }
    }
    record('S2 preload issues zero model requests (2 s window)', pass, rows.join(' | '));
  }

  // --- S3: 8 idle sessions, none prompted -> still zero requests, clean exit
  {
    const rows = [];
    let pass = true;
    const rss = {};
    for (const [name, bundle] of [
      ['control', CONTROL],
      ['candidate', CANDIDATE],
    ]) {
      const s = await probe(bundle, ['--mode', 'idle', '--sessions', '8', '--dwell', '2500']);
      const ok =
        s.ok &&
        s.gates.providerRequestsDuringPreloadWindow === 0 &&
        s.childExitCode === 0 &&
        !s.gates.unhandledRejection;
      pass &&= ok;
      rss[name] = s.rssKib;
      rows.push(`${name}: sessions=${s.sessionCount} req=${s.gates?.providerRequestsDuringPreloadWindow} exit=${s.childExitCode} rss=${(s.rssKib / 1024).toFixed(1)}MiB`);
    }
    rows.push(`ΔRSS=${((rss.candidate - rss.control) / 1024).toFixed(1)}MiB`);
    record('S3 8 idle prepared sessions: no requests, clean exit', pass, rows.join(' | '));
  }

  // --- S4: unusable provider endpoint -> no unhandled rejection, no crash ---
  {
    const rows = [];
    let pass = true;
    for (const [name, bundle] of [
      ['control', CONTROL],
      ['candidate', CANDIDATE],
    ]) {
      const s = await probe(bundle, ['--mode', 'broken', '--dwell', '600', '--timeout', '45000']);
      const ok = !s.gates?.unhandledRejection && s.childExitCode === 0;
      pass &&= ok;
      rows.push(`${name}: unhandled=${s.gates?.unhandledRejection} exit=${s.childExitCode} promptErr=${s.gates?.promptError ? 'yes' : 'no'}`);
    }
    record('S4 unreachable provider: no unhandled rejection, clean exit', pass, rows.join(' | '));
  }

  // --- S5: immediate prompt correctness (0 ms dwell), repeated ------------
  {
    const rows = [];
    let pass = true;
    for (const [name, bundle] of [
      ['control', CONTROL],
      ['candidate', CANDIDATE],
    ]) {
      for (let i = 0; i < REPEATS; i++) {
        const s = await probe(bundle, ['--mode', 'prompt', '--dwell', '0']);
        const ok =
          s.ok &&
          s.gates.firstChunkText === 'PONG' &&
          s.gates.totalProviderRequests === 1 &&
          s.gates.stopReason === 'end_turn' &&
          s.childExitCode === 0;
        pass &&= ok;
        rows.push(`${name}#${i}: out=${s.gates?.firstChunkText} reqs=${s.gates?.totalProviderRequests} stop=${s.gates?.stopReason}`);
      }
    }
    record('S5 immediate prompt: exactly one request, correct output', pass, rows.join(' | '));
  }

  const outPath = path.join(__dirname, 'scenarios.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
};

run();
