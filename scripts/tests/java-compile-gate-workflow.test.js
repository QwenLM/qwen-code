/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('Java compile gate workflow', () => {
  const yml = parse(
    readFileSync('.github/workflows/java-compile-gate.yml', 'utf8'),
  );
  const jobs = yml.jobs;
  const steps = jobs.compile.steps;
  const step = (name) => {
    const found = steps.find((candidate) => candidate.name === name);
    expect(found, name).toBeDefined();
    return found;
  };
  const javaPaths = [
    '.github/workflows/java-compile-gate.yml',
    'packages/managed-agent-server/**',
    'packages/sdk-java/**',
  ];

  it('runs on the pull request and on the push to main', () => {
    // The pull-request arm stops the merge; the push arm is what makes a
    // broken `main` attributable to the commit that caused it. Dropping
    // either one reopens the gap #14381 describes.
    expect(Object.keys(yml.on).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    expect(yml.on.push.branches).toEqual(['main']);
    // Both arms stay path-filtered, and the two lists agree: the push arm
    // silently skipping a path the pull-request arm covers would leave the
    // breakage it lets through with no post-merge verdict either. The
    // workflow file is on both lists so that editing this gate re-runs it.
    expect([...yml.on.pull_request.paths].sort()).toEqual(javaPaths);
    expect([...yml.on.push.paths].sort()).toEqual(javaPaths);
    expect(yml.permissions).toEqual({ contents: 'read' });
    // Never cancel a run on `main`: a cancelled push run has no verdict to
    // attribute, and the same starvation measurement that shaped ci.yml's
    // policy applies here. A pull request still supersedes its own run.
    expect(String(yml.concurrency['cancel-in-progress']).trim()).toBe(
      "${{ github.ref != 'refs/heads/main' }}",
    );
  });

  it('declares a fixed timeout', () => {
    // scripts/check-ci-budget.mjs records an undeclared job timeout as
    // unbounded, so losing this number raises the PR-stage ceiling the
    // ledger ratchets on without touching the ledger.
    expect(jobs.compile['timeout-minutes']).toBe(30);
    expect(Object.keys(jobs)).toEqual(['compile']);
  });

  it('uses the JDK 21 toolchain the server module builds for', () => {
    // managed-agent-server targets release 21; the Maven cache is what keeps
    // this gate at minutes rather than a cold resolve on every Java pull
    // request.
    const setup = step('Set up Java 21');
    expect(setup.uses).toContain('actions/setup-java@');
    expect(setup.with.distribution).toBe('temurin');
    expect(setup.with['java-version']).toBe('21');
    expect(setup.with.cache).toBe('maven');
    expect(setup.with['cache-dependency-path']).toContain(
      'packages/managed-agent-server/pom.xml',
    );
  });

  it('installs the Java SDK before compiling the server', () => {
    // The server resolves the SDK from the local repository rather than from
    // a released jar, so the order is load-bearing: reversed, the server
    // build fails on a missing sibling artifact instead of on the change
    // under test.
    const install = step('Install the Java SDK');
    const compile = step('Compile the Managed Agent Server');
    expect(install['working-directory']).toBe('packages/sdk-java/qwencode');
    expect(compile['working-directory']).toBe('packages/managed-agent-server');
    expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(compile));
    expect(install.run).toContain('-DskipTests');
    expect(install.run).toMatch(/\bclean install$/);
  });

  it('compiles the test sources, which is where the breakage lands', () => {
    // `-DskipTests` skips execution and still compiles tests, which is the
    // half this gate exists for (#14370 broke `main` at testCompile).
    // `-Dmaven.test.skip=true` would disable that compilation, and a bare
    // `clean compile` would never reach it — pin the spelling, not just the
    // intent, because both mutations leave a green gate behind.
    const compile = step('Compile the Managed Agent Server');
    expect(compile.run).toContain('-DskipTests');
    expect(compile.run).not.toContain('-Dmaven.test.skip');
    expect(compile.run).toMatch(/\bclean package$/);
  });

  it('runs both checkstyle configurations', () => {
    // The runtime-broker execution id is the second configuration in
    // managed-agent-server's pom; dropping it leaves the broker sources
    // unlinted while the step still passes.
    expect(step('Run Java SDK Checkstyle')['working-directory']).toBe(
      'packages/sdk-java/qwencode',
    );
    expect(step('Run Java SDK Checkstyle').run).toBe(
      'mvn --batch-mode --no-transfer-progress checkstyle:check',
    );
    const server = step('Run Managed Agent Server Checkstyle');
    expect(server['working-directory']).toBe('packages/managed-agent-server');
    expect(server.run).toBe(
      'mvn --batch-mode --no-transfer-progress checkstyle:check checkstyle:check@runtime-broker-checkstyle',
    );
  });
});
