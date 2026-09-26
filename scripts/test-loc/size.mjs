#!/usr/bin/env node
// Size and structural proxies for one package's test code (metrics S1–S4,
// P1–P7 in knowledge/qwen-code/design/test-code-size-metrics.md).
//
//   node size.mjs <repoDir> <packageRelPath> [--json]
//
// Counts tracked and untracked, non-ignored files. A path is a test path when it matches the
// classifier below; snapshot and fixture files count toward S1/S2 so moving
// lines into them is not a cut.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, pkg, ...flags] = process.argv.slice(2);
if (!repo || !pkg) {
  console.error('usage: size.mjs <repoDir> <packageRelPath> [--json]');
  process.exit(2);
}
const asJson = flags.includes('--json');

const TEST_PATH =
  /(\.test\.|\.spec\.|\/__tests__\/|\/__mocks__\/|\/__fixtures__\/|\/fixtures\/|\/test-utils\/|\/testUtils\/|\.snap$)/;
const SKIP = /\/(dist|build|out|coverage|node_modules|vendor)\//;
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const CASE_START =
  /^\s*(it|test)(\.each\([^)]*\)|\.skip|\.only|\.todo|\.concurrent)?\s*\(/;
const MOCK_ASSERT =
  /\.(toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|not\.toHaveBeenCalled|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith)\b/g;

const files = [
  ...new Set(
    execFileSync(
      'git',
      [
        '-C',
        repo,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        pkg,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      },
    )
      .split('\0')
      .filter(Boolean)
      .filter((f) => !SKIP.test('/' + f) && fs.existsSync(path.join(repo, f))),
  ),
];

const read = (f) => fs.readFileSync(path.join(repo, f));
if (files.length === 0) {
  console.error(`No files found for package: ${pkg}`);
  process.exit(2);
}
const lineCount = (buf) => {
  const s = buf.toString('utf8');
  return s.length ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
};

const r = {
  package: pkg,
  s1_test_loc: 0,
  s2_test_bytes: 0,
  s3_cases: 0,
  impl_loc: 0,
  impl_files: 0,
  test_files: 0,
  test_code_files: 0,
  snapshot_lines: 0,
  fixture_lines: 0,
  cases_single_expect: 0,
  cases_mock_only: 0,
  cases_over_80: 0,
  preamble_lines: 0,
  skipped: 0,
  files_over_5000: 0,
  lines_in_files_over_5000: 0,
  dup_windows: 0,
  total_windows: 0,
  modules_with_multiple_test_files: 0,
};

const testFilesPerModule = new Map();
for (const f of files) {
  const isTest = TEST_PATH.test('/' + f);
  if (!isTest) {
    if (CODE.test(f) && !f.endsWith('.d.ts')) {
      r.impl_loc += lineCount(read(f));
      r.impl_files++;
    }
    continue;
  }
  const buf = read(f);
  const n = lineCount(buf);
  r.s1_test_loc += n;
  r.s2_test_bytes += buf.length;
  r.test_files++;
  if (f.endsWith('.snap')) r.snapshot_lines += n;
  else if (!CODE.test(f)) r.fixture_lines += n;
  if (!/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.test(f)) continue;
  r.test_code_files++;
  if (n > 5000) {
    r.files_over_5000++;
    r.lines_in_files_over_5000 += n;
  }
  const mod = f
    .replace(/\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/, '')
    .replace(/\.[\w-]+$/, '');
  testFilesPerModule.set(mod, (testFilesPerModule.get(mod) || 0) + 1);

  const lines = buf.toString('utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    if (CASE_START.test(l)) starts.push(i);
  });
  r.preamble_lines += starts[0] ?? 0;
  r.skipped += (
    buf.toString('utf8').match(/\b(it|test|describe)\.(skip|todo)\b/g) || []
  ).length;
  for (let i = 0; i < starts.length; i++) {
    const body = lines
      .slice(starts[i], starts[i + 1] ?? lines.length)
      .join('\n');
    const len = (starts[i + 1] ?? lines.length) - starts[i];
    r.s3_cases++;
    const ex = (body.match(/\bexpect\s*\(/g) || []).length;
    const mock = (body.match(MOCK_ASSERT) || []).length;
    if (ex === 1) r.cases_single_expect++;
    if (ex > 0 && mock === ex) r.cases_mock_only++;
    if (len > 80) r.cases_over_80++;
  }
  const norm = lines.map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  for (let i = 0; i + 6 <= norm.length; i++) {
    const k = norm.slice(i, i + 6).join('\u0001');
    r.total_windows++;
    if (seen.has(k)) r.dup_windows++;
    else seen.add(k);
  }
}
for (const c of testFilesPerModule.values())
  if (c > 1) r.modules_with_multiple_test_files++;

const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : 0);
const out = {
  ...r,
  s4_test_to_impl: +(r.s1_test_loc / Math.max(1, r.impl_loc)).toFixed(2),
  p1_lines_per_case: +(r.s1_test_loc / Math.max(1, r.s3_cases)).toFixed(1),
  p2_within_file_dup_pct: pct(r.dup_windows, r.total_windows),
  p3_single_expect_pct: pct(r.cases_single_expect, r.s3_cases),
  p4_mock_only_pct: pct(r.cases_mock_only, r.s3_cases),
  p5_preamble_pct: pct(r.preamble_lines, r.s1_test_loc),
  p6_files_over_5000_pct: pct(r.lines_in_files_over_5000, r.s1_test_loc),
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const row = (k, v) => console.log(k.padEnd(34) + String(v).padStart(12));
  row('S1 test LOC', out.s1_test_loc);
  row('S2 test bytes', out.s2_test_bytes);
  row('S3 cases', out.s3_cases);
  row('S4 test/impl', out.s4_test_to_impl);
  row('impl LOC', out.impl_loc);
  row('P1 lines/case', out.p1_lines_per_case);
  row('P2 within-file dup %', out.p2_within_file_dup_pct);
  row('P3 single-expect %', out.p3_single_expect_pct);
  row('P4 mock-only %', out.p4_mock_only_pct);
  row('P5 preamble %', out.p5_preamble_pct);
  row(
    'P6 files >5000 (n / %)',
    `${out.files_over_5000} / ${out.p6_files_over_5000_pct}`,
  );
  row('P7 modules w/ >1 test file', out.modules_with_multiple_test_files);
  row('skipped', out.skipped);
  row('snapshot lines', out.snapshot_lines);
  row('fixture lines', out.fixture_lines);
}
