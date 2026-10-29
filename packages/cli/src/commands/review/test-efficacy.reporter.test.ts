/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyProbeRun, findVitestBin } from './test-efficacy.js';

const cases = [
  {
    name: 'passing assertion',
    file: 'passing.test.js',
    body: "import { it, expect } from 'vitest'; it('passes', () => expect(1).toBe(1));",
    verdict: 'inert',
  },
  {
    name: 'failed assertion',
    file: 'assertion.test.js',
    body: "import { it, expect } from 'vitest'; it('fails', () => expect(1).toBe(2));",
    verdict: 'gated',
  },
  {
    name: 'beforeAll error',
    file: 'before-all-error.test.js',
    body: "import { beforeAll, it, expect } from 'vitest'; beforeAll(() => { throw new Error('fixture setup failed'); }); it('never reaches assertion', () => expect(1).toBe(1));",
    verdict: 'inconclusive',
  },
  {
    name: 'beforeAll assertion',
    file: 'before-all-assertion.test.js',
    body: "import { beforeAll, it, expect } from 'vitest'; beforeAll(() => expect(1).toBe(2)); it('never reaches assertion', () => expect(1).toBe(1));",
    verdict: 'inconclusive',
  },
  {
    name: 'beforeEach error',
    file: 'before-each-error.test.js',
    body: "import { beforeEach, it, expect } from 'vitest'; beforeEach(() => { throw new Error('fixture setup failed'); }); it('never reaches assertion', () => expect(1).toBe(1));",
    verdict: 'inconclusive',
  },
  {
    name: 'afterAll error',
    file: 'after-all-error.test.js',
    body: "import { afterAll, it, expect } from 'vitest'; afterAll(() => { throw new Error('fixture teardown failed'); }); it('passes', () => expect(1).toBe(1));",
    verdict: 'inconclusive',
  },
  {
    name: 'test runtime error',
    file: 'runtime-error.test.js',
    body: "import { it } from 'vitest'; it('throws before an assertion', () => { throw new Error('fixture runtime failed'); });",
    verdict: 'inconclusive',
  },
  {
    name: 'test timeout',
    file: 'timeout.test.js',
    body: "import { it } from 'vitest'; it('never reaches an assertion', () => new Promise(() => {}), 20);",
    verdict: 'inconclusive',
  },
] as const;

describe('classifyProbeRun with real Vitest reporter output', () => {
  let root: string;
  let stdout: string;
  let exitCode: number;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-probe-reporter-'));
    const vitestBin = findVitestBin(process.cwd());
    const modules = dirname(dirname(vitestBin));
    symlinkSync(modules, join(root, 'node_modules'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      "export default { test: { include: ['*.test.js'], environment: 'node', pool: 'forks', maxWorkers: 1, minWorkers: 1, fileParallelism: false } };\n",
    );
    for (const entry of cases) {
      writeFileSync(join(root, entry.file), entry.body);
    }
    const report = join(root, 'report.json');
    const run = spawnSync(
      process.execPath,
      [
        vitestBin,
        'run',
        '--config',
        join(root, 'vitest.config.mjs'),
        '--reporter=json',
        '--outputFile',
        report,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(run.error).toBeUndefined();
    expect(run.signal).toBeNull();
    expect(run.status).toBe(1);
    stdout = readFileSync(report, 'utf8');
    exitCode = run.status ?? -1;
    const parsed = JSON.parse(stdout) as { testResults: unknown[] };
    expect(parsed.testResults).toHaveLength(cases.length);
    const evidenceDir = process.env['QWEN_PROBE_REPORT_DIR'];
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'real-vitest.json'), stdout);
      writeFileSync(join(evidenceDir, 'fixture-run.stderr'), run.stderr);
    }
  }, 40_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(cases)('$name is $verdict', ({ file, verdict }) => {
    const actual = classifyProbeRun(exitCode, stdout, [file]);
    expect(actual).toHaveLength(1);
    expect(actual[0].verdict).toBe(verdict);
  });
});
