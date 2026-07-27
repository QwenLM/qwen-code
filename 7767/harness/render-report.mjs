/**
 * Prints the PR #7767 verification summary from the artifacts written by
 * run-pairs.mjs / run-scenarios.mjs / mutate.mjs. Nothing is recomputed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const D = path.dirname(fileURLToPath(import.meta.url));
const c = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  g: '\x1b[32m', red: '\x1b[31m', y: '\x1b[33m', cy: '\x1b[36m', gray: '\x1b[90m',
};
const j = (f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8'));
const f2 = (x) => (x == null ? '—' : x.toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const which = process.argv[2] ?? 'all';

if (which === 'e2e' || which === 'all') {
  console.log(`${c.b}PR #7767 — real-ACP end-to-end verification${c.r}  ${c.gray}macOS 15.7.7 · Apple M1 Pro (10 cores) · node 22.23.1${c.r}`);
  console.log(`${c.gray}control  d44030a4c (PR base)      candidate 4120aa01c (PR head)      direct ACP over stdio, fake OpenAI provider (50 ms)${c.r}\n`);

  const sc = j('scenarios.json');
  console.log(`${c.b}Functional scenarios${c.r} ${c.gray}(each run against both bundles)${c.r}`);
  for (const s of sc) {
    console.log(`  ${s.pass ? c.g + 'PASS' : c.red + 'FAIL'}${c.r}  ${s.name}`);
    console.log(`        ${c.gray}${s.detail.length > 150 ? s.detail.slice(0, 147) + '…' : s.detail}${c.r}`);
  }

  console.log(`\n${c.b}Paired A/B, candidate − control (negative = candidate faster), bootstrap 95% CI${c.r}`);
  console.log(
    `  ${c.gray}${pad('dwell', 7)}${rpad('pairs', 7)}  ${pad('prompt→provider request', 30)}${pad('process→session ready', 26)}${pad('session create', 24)}${c.r}`,
  );
  for (const d of [0, 25, 50, 100, 200]) {
    const p = path.join(D, `summary-dwell${d}.json`);
    if (!fs.existsSync(p)) continue;
    const o = j(`summary-dwell${d}.json`);
    const a = o.stats.promptToProviderRequestArrivalMs;
    const r = o.stats.processToSessionReadyMs;
    const cr = o.stats.sessionCreateMs;
    const cell = (v) => `${rpad(f2(v.pairedMedianDelta), 7)} [${f2(v.ci95[0])}, ${f2(v.ci95[1])}]`;
    const col = a.pairedMedianDelta < -5 ? c.g : c.y;
    console.log(
      `  ${pad(d + ' ms', 7)}${rpad(o.validPairs + '/' + o.pairs, 7)}  ${col}${pad(cell(a) + ` ${a.candidateFasterIn}/${a.n}`, 30)}${c.r}${pad(cell(r), 26)}${pad(cell(cr), 24)}`,
    );
  }

  const aa = j('summary-AA-realtrees.json');
  console.log(
    `\n  ${c.cy}A/A${c.r}     ${rpad(aa.validPairs + '/' + aa.pairs, 7)}  ${pad(f2(aa.stats.promptToProviderRequestArrivalMs.pairedMedianDelta) + ' [' + f2(aa.stats.promptToProviderRequestArrivalMs.ci95[0]) + ', ' + f2(aa.stats.promptToProviderRequestArrivalMs.ci95[1]) + ']', 30)}` +
      `${pad(f2(aa.stats.processToSessionReadyMs.pairedMedianDelta) + ' [' + f2(aa.stats.processToSessionReadyMs.ci95[0]) + ', ' + f2(aa.stats.processToSessionReadyMs.ci95[1]) + ']', 26)}` +
      `${pad(f2(aa.stats.sessionCreateMs.pairedMedianDelta) + ' [' + f2(aa.stats.sessionCreateMs.ci95[0]) + ', ' + f2(aa.stats.sessionCreateMs.ci95[1]) + ']', 24)}`,
  );
  console.log(
    `  ${c.gray}A/A = two independently built clean worktrees at the SAME commit, byte-identical cli.js — the harness noise floor.${c.r}`,
  );

  let reqs = 0, unh = 0, nz = 0, np = 0;
  for (const d of [0, 25, 50, 100, 200]) {
    const p = path.join(D, `summary-dwell${d}.json`);
    if (!fs.existsSync(p)) continue;
    const o = j(`summary-dwell${d}.json`);
    reqs += o.gateSummary.preloadWindowProviderRequests;
    unh += o.gateSummary.unhandledRejections;
    nz += o.gateSummary.nonZeroExits;
    np += o.validPairs;
  }
  console.log(
    `\n${c.b}Gates over all ${np} valid pairs${c.r}   provider requests during the preload window: ${c.g}${reqs}${c.r}   unhandled rejections: ${c.g}${unh}${c.r}   non-zero child exits: ${c.g}${nz}${c.r}`,
  );
}

if (which === 'mutation' || which === 'all') {
  const mu = j('mutation-results.json');
  console.log(`\n${c.b}Mutation matrix${c.r} ${c.gray}— break one claimed behaviour, re-run the suite the PR added for it${c.r}`);
  for (const m of mu) {
    const tag = !m.applied ? `${c.y}SKIP    ` : m.killed ? `${c.g}KILLED  ` : `${c.red}SURVIVED`;
    console.log(`  ${tag}${c.r} ${c.dim}${m.id}${c.r}  ${m.desc}`);
    if (m.applied && m.killed) {
      const names = (m.failed ?? []).map((s) => s.replace(/\x1b\[\d+m/g, '').replace(/^.*>\s*/, '')).slice(0, 2);
      console.log(`            ${c.gray}killed by: ${names.join(' | ') || '(suite red)'}${c.r}`);
    }
    if (m.applied && !m.killed) {
      console.log(`            ${c.red}no test failed${c.r}`);
    }
  }
  const applied = mu.filter((m) => m.applied);
  const killed = applied.filter((m) => m.killed);
  console.log(
    `\n  ${c.b}${killed.length}/${applied.length} killed${c.r}  ${c.gray}(suites: contentGenerator.test.ts 21, config.test.ts 437, acpAgent.test.ts 322 — all green unmutated)${c.r}`,
  );
}
