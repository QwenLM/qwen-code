/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'packages/cli');
const { scripts } = JSON.parse(
  readFileSync(path.join(cli, 'package.json'), 'utf8'),
);

describe('CLI CI failure budget', () => {
  it.each([
    ['test:ci', true, 1, 2, 3],
    ['test:ci', false, 0, 0, 9],
    ['test', true, 3, 0, 9],
  ])(
    '%s with permanent failure=%s reports %i failures and leaves %i tests unrun after %i attempts',
    (script, permanent, failures, unrun, attempts) => {
      const fixture = mkdtempSync(path.join(tmpdir(), 'qwen-cli-ci-'));
      try {
        const evidence = path.join(fixture, 'attempts.txt');
        const jsonReport = path.join(fixture, 'results.json');
        const junitReport = path.join(fixture, 'junit.xml');
        const config = path.join(fixture, 'vitest.config.mjs');
        writeFileSync(
          config,
          `export default ${JSON.stringify({
            test: {
              globals: true,
              include: ['fixture.test.js'],
              maxWorkers: 1,
              minWorkers: 1,
              reporters: ['json', 'junit'],
              outputFile: { json: jsonReport, junit: junitReport },
            },
          })};`,
        );
        writeFileSync(
          path.join(fixture, 'fixture.test.js'),
          `import { appendFileSync } from 'node:fs';
          for (const name of ['first settle', 'second settle', 'third settle']) {
            let attempts = 0;
            it(name, async () => {
              attempts++;
              appendFileSync(${JSON.stringify(evidence)}, name + '\\n');
              await vi.waitFor(() => {
                expect(${permanent} || attempts < 3, 'hasActivePrompt never cleared').toBe(false);
              }, { timeout: 20, interval: 5 });
            });
          }`,
        );

        const [command, ...args] = scripts[script].split(/\s+/);
        expect(command).toBe('vitest');
        const result = spawnSync(
          process.execPath,
          [
            path.join(root, 'node_modules/vitest/vitest.mjs'),
            ...args,
            '--root',
            fixture,
            '--config',
            config,
            '--retry=2',
          ],
          {
            cwd: cli,
            encoding: 'utf8',
            timeout: 60_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(
          failures ? 1 : 0,
        );
        const report = JSON.parse(readFileSync(jsonReport, 'utf8'));
        expect(report.numFailedTests).toBe(failures);
        expect(report.numPassedTests).toBe(3 - failures - unrun);
        const assertions = report.testResults[0].assertionResults;
        expect(assertions.map(({ status }) => status)).toEqual(
          unrun
            ? ['failed', 'pending', 'pending']
            : Array(3).fill(failures ? 'failed' : 'passed'),
        );
        const started = readFileSync(evidence, 'utf8').trim().split('\n');
        expect(started).toHaveLength(attempts);
        expect(started.filter((name) => name === 'first settle')).toHaveLength(
          3,
        );
        const junit = readFileSync(junitReport, 'utf8');
        expect(junit).toContain(`failures="${failures}"`);
        if (failures) expect(junit).toContain('hasActivePrompt never cleared');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
