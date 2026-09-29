/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-failsafe-reports.js',
);
let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-failsafe-reports-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A Maven module holding test sources and the failsafe reports of a run.
// Each report lists `[ran, skipped]` test cases as failsafe writes them, with
// a passing test's log in CDATA, where markup is only text.
function module(name, sources, reports = {}, properties = '') {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src', 'test', 'java'), { recursive: true });
  for (const className of sources) {
    const file = `${join(dir, 'src', 'test', 'java', ...className.split('.'))}.java`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  const reportDir = join(dir, 'target', 'failsafe-reports');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'failsafe-summary.xml'), '<failsafe-summary/>');
  for (const [className, [ran, skipped]] of Object.entries(reports)) {
    const cases = [
      ...Array(ran).fill(
        '<testcase name="passes"><system-out><![CDATA[log: <skipped/>]]></system-out></testcase>',
      ),
      ...Array(skipped).fill(
        '<testcase name="skips"><skipped message="disabled"/></testcase>',
      ),
    ];
    writeFileSync(
      join(reportDir, `TEST-${className}.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${className}" tests="${ran + skipped}" skipped="${skipped}">\n<properties>${properties}</properties>\n${cases.join('\n')}\n</testsuite>\n`,
    );
  }
  return dir;
}

function check(...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('check-failsafe-reports', () => {
  it('passes when every integration test of the family ran, whatever the other family did', () => {
    const sources = [
      'com.example.OrdersIT',
      'com.example.store.LedgerIT',
      'com.example.HostedFlowIT',
      'com.example.HostedFlowTest',
    ];
    const mariadb = module('mariadb', sources, {
      'com.example.OrdersIT': [2, 1],
      'com.example.OrdersIT$Retry': [1, 0],
      'com.example.store.LedgerIT': [1, 0],
    });
    const result = check('non-hosted', mariadb);
    expect(result.output).toContain('com.example.OrdersIT ran 3 test(s)');
    expect(result.output).toContain('com.example.store.LedgerIT ran 1 test(s)');
    expect(result.status).toBe(0);
    const hosted = module('hosted', sources, {
      'com.example.HostedFlowIT': [1, 0],
    });
    expect(check('hosted', hosted).status).toBe(0);
  });

  it('counts the test cases failsafe folds into an outer report', () => {
    const dir = module('nested', ['com.example.OrdersIT']);
    writeFileSync(
      join(dir, 'target', 'failsafe-reports', 'TEST-com.example.OrdersIT.xml'),
      '<testsuite name="com.example.OrdersIT" tests="0" skipped="0">\n<properties/>\n<testcase name="runs" classname="com.example.OrdersIT$Inner"/>\n</testsuite>\n',
    );
    const result = check('non-hosted', dir);
    expect(result.output).toContain('com.example.OrdersIT ran 1 test(s)');
    expect(result.status).toBe(0);
  });

  it('names every integration test of the family that ran no test', () => {
    const dir = module(
      'narrowed',
      ['com.example.OrdersIT', 'com.example.LedgerIT', 'com.example.AuditIT'],
      {
        'com.example.OrdersIT': [2, 0],
        'com.example.LedgerIT': [0, 0],
        'com.example.AuditIT': [0, 2],
      },
    );
    const result = check('non-hosted', dir);
    expect(result.output).toContain('com.example.LedgerIT ran no test');
    expect(result.output).toContain('com.example.AuditIT ran no test');
    expect(result.output).not.toContain('com.example.OrdersIT ran no test');
    expect(result.status).toBe(1);
    const unrun = module('unrun', ['com.example.HostedFlowIT']);
    expect(check('hosted', unrun).output).toContain(
      'com.example.HostedFlowIT ran no test',
    );
  });

  it('accepts a class annotated @Disabled at its source', () => {
    const dir = module(
      'declared',
      ['com.example.HostedOrdersIT', 'com.example.HostedFlowIT'],
      {
        'com.example.HostedOrdersIT': [1, 0],
        'com.example.HostedFlowIT': [0, 3],
      },
    );
    writeFileSync(
      join(dir, 'src', 'test', 'java', 'com', 'example', 'HostedFlowIT.java'),
      '@Disabled("not wired on this branch")\nclass HostedFlowIT {}\n',
    );
    const result = check('hosted', dir);
    expect(result.output).toContain(
      'com.example.HostedFlowIT is disabled at its source',
    );
    expect(result.status).toBe(0);
    // A class with no report and no @Disabled still fails.
    const silent = module(
      'silent',
      ['com.example.OrdersIT', 'com.example.LedgerIT'],
      {
        'com.example.OrdersIT': [1, 0],
        'com.example.LedgerIT': [0, 1],
      },
    );
    const skipped = check('non-hosted', silent);
    expect(skipped.output).toContain('com.example.LedgerIT ran no test');
    expect(skipped.status).toBe(1);
  });

  it('rejects a run under -Dit.test even when every class ran a test', () => {
    const dir = module(
      'filtered',
      ['com.example.OrdersIT', 'com.example.LedgerIT'],
      {
        'com.example.OrdersIT': [1, 0],
        'com.example.LedgerIT': [1, 0],
      },
      '<property name="it.test" value="OrdersIT#one,LedgerIT#one"/>',
    );
    const result = check('non-hosted', dir);
    expect(result.output).toContain(
      '-Dit.test=OrdersIT#one,LedgerIT#one narrowed this run',
    );
    expect(result.status).toBe(1);
    const listed = module(
      'listed',
      ['com.example.OrdersIT'],
      { 'com.example.OrdersIT': [1, 0] },
      '<property name="failsafe.includesFile" value="/work/selected.txt"/>',
    );
    expect(check('non-hosted', listed).output).toContain(
      '-Dfailsafe.includesFile=/work/selected.txt narrowed this run',
    );
  });

  it('rejects a report that records no properties', () => {
    const dir = module('bare', ['com.example.OrdersIT']);
    writeFileSync(
      join(dir, 'target', 'failsafe-reports', 'TEST-com.example.OrdersIT.xml'),
      '<testsuite name="com.example.OrdersIT" tests="1" skipped="0">\n<testcase name="runs"/>\n</testsuite>\n',
    );
    const result = check('non-hosted', dir);
    expect(result.output).toContain(
      'TEST-com.example.OrdersIT.xml records no properties',
    );
    expect(result.status).toBe(1);
  });

  it('rejects a test class of the other family, or no family at all', () => {
    const mariadb = module('mariadb', ['com.example.HostedFlowIT'], {
      'com.example.HostedFlowIT$Retry': [1, 0],
      'com.example.OrdersTest': [1, 0],
    });
    const result = check('non-hosted', mariadb);
    expect(result.output).toContain(
      'com.example.HostedFlowIT ran outside the non-hosted family',
    );
    expect(result.output).toContain(
      'com.example.OrdersTest ran outside the non-hosted family',
    );
    expect(result.status).toBe(1);
    const hosted = module(
      'hosted',
      ['com.example.HostedFlowIT', 'com.example.OrdersIT'],
      {
        'com.example.HostedFlowIT': [1, 0],
        'com.example.OrdersIT': [1, 0],
        'com.example.HostedFlowTest': [1, 0],
      },
    );
    const widened = check('hosted', hosted);
    expect(widened.output).toContain(
      'com.example.OrdersIT ran outside the hosted family',
    );
    expect(widened.output).toContain(
      'com.example.HostedFlowTest ran outside the hosted family',
    );
    expect(widened.status).toBe(1);
  });

  it('checks every module it is given', () => {
    const complete = module('complete', ['com.example.OrdersIT'], {
      'com.example.OrdersIT': [1, 0],
    });
    const incomplete = module('incomplete', ['com.example.LedgerIT']);
    const result = check('non-hosted', complete, incomplete);
    expect(result.output).toContain('com.example.LedgerIT ran no test');
    expect(result.status).toBe(1);
    const noFamily = join(root, 'no-family');
    mkdirSync(join(noFamily, 'src', 'test', 'java'), { recursive: true });
    expect(check('hosted', noFamily).status).toBe(0);
  });

  it('refuses an unknown family or a missing module', () => {
    expect(check('mariadb', root).status).toBe(2);
    expect(check('hosted').status).toBe(2);
    expect(check('hosted', join(root, 'absent')).status).not.toBe(0);
  });
});
