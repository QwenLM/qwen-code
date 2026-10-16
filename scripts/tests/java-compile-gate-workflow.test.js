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
  // The filter matches the two modules the job builds — the spelling
  // release-managed-agent-reference.yml uses for the same pair. The ACP SDK
  // client under packages/sdk-java/client stays out: with the broader
  // packages/sdk-java/** a client-only change collected a green "Compile and
  // checkstyle the Java modules" verdict over sources no step reads. The
  // qwencode tree must stay on both arms — the server's checkstyle configs
  // live in it (packages/managed-agent-server/pom.xml resolves
  // ../sdk-java/qwencode/qwen-code-checks.xml).
  const javaPaths = [
    '.github/workflows/java-compile-gate.yml',
    'packages/managed-agent-server/**',
    'packages/sdk-java/qwencode/**',
  ];

  it('runs on the pull request and on the push to main', () => {
    // Neither arm blocks a merge on its own — the `main` ruleset carries no
    // required status check — so the pull-request arm is the pre-merge
    // signal a reviewer reads, and the push arm is what makes a broken
    // `main` attributable to the commit that caused it. Dropping either one
    // reopens the gap #14381 describes.
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
    // The other half of the policy: the group itself. GitHub replaces a
    // group's PENDING run even with cancel-in-progress off, so the event
    // name must be in it — a manual dispatch of `main` would otherwise
    // displace a queued push run, the push's cancelled conclusion files no
    // issue, and the dispatch's own failure is outside the failure
    // watcher's push-only filter (main-ci-failure-issue.yml). The same
    // reason ci.yml and e2e.yml scope their groups by event.
    expect(String(yml.concurrency.group)).toBe(
      'java-compile-gate-${{ github.event_name }}-${{ github.ref }}',
    );
    const groupOnMain = (event) =>
      String(yml.concurrency.group)
        .replaceAll('${{ github.event_name }}', event)
        .replaceAll('${{ github.ref }}', 'refs/heads/main');
    expect(groupOnMain('push')).not.toBe(groupOnMain('workflow_dispatch'));
  });

  it('declares a fixed timeout', () => {
    // scripts/check-ci-budget.mjs records an undeclared job timeout as
    // unbounded, so losing this number raises the PR-stage ceiling the
    // ledger ratchets on without touching the ledger.
    expect(jobs.compile['timeout-minutes']).toBe(30);
    expect(Object.keys(jobs)).toEqual(['compile']);
    // The four mvn steps carry no MAVEN_ARGS and no job-local
    // -Dmaven.repo.local, so this lane is only correct on an ephemeral
    // hosted runner: on a shared pool host two runs would clean-install
    // over each other's coordinates — the hazard sdk-java.yml defends
    // against with a job-local repository.
    expect(jobs.compile['runs-on']).toBe('ubuntu-latest');
  });

  it('checks out the tree without persisting credentials', () => {
    // The pull-request arm executes the contributed pom's build plugins, so
    // the token must not land in .git/config for them to read. The actions
    // stay pinned to full SHAs — a repointed mutable tag would run under the
    // same trust as this workflow's own code.
    const checkout = step('Checkout');
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('uses the JDK 21 toolchain the server module builds for', () => {
    // managed-agent-server targets release 21; the Maven cache is what keeps
    // this gate at minutes rather than a cold resolve on every Java pull
    // request.
    const setup = step('Set up Java 21');
    expect(setup.uses).toMatch(/^actions\/setup-java@[0-9a-f]{40}$/);
    expect(setup.with.distribution).toBe('temurin');
    expect(setup.with['java-version']).toBe('21');
    expect(setup.with.cache).toBe('maven');
    // The whole path list is the cache key: dropping a pom line rotates no
    // key when that pom's dependencies change, so their downloads are
    // re-fetched on every run until an unrelated edit rotates it.
    expect(setup.with['cache-dependency-path'].trim()).toBe(
      'packages/sdk-java/qwencode/pom.xml\npackages/managed-agent-server/pom.xml',
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
    // `install` passes through the verify phase the SDK's own checkstyle
    // execution binds to; without the skip a style break fails a step named
    // "Install" and the server compile verdict below is never produced.
    expect(install.run).toContain('-Dcheckstyle.skip=true');
  });

  it('compiles the test sources, which is where the breakage lands', () => {
    // `clean test-compile` compiles main AND test sources, and the latter is
    // the half this gate exists for (#14370 broke `main` at testCompile).
    // `-Dmaven.test.skip=true` would disable that compilation, and a bare
    // `clean compile` would never reach it — pin the spelling, not just the
    // intent, because both mutations leave a green gate behind. Packaging is
    // deliberately absent: release-managed-agent-reference.yml builds the
    // same tree per pull request.
    const compile = step('Compile the Managed Agent Server');
    expect(compile.run).not.toContain('-Dmaven.test.skip');
    expect(compile.run).toMatch(/\bclean test-compile$/);
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

  it('keeps its checkstyle steps identical to the sdk-java.yml copies', () => {
    // Each file pins its own copy of these two steps and nothing else
    // asserts the copies agree: a third checkstyle goal added to
    // sdk-java.yml — the way runtime-broker-checkstyle arrived — would drift
    // past both suites and the gate would lint one configuration fewer.
    // Compare run and working-directory only: sdk-java.yml's copies carry an
    // env MAVEN_ARGS indirection for shared self-hosted hosts that this gate
    // deliberately omits.
    const sdkJava = parse(
      readFileSync('.github/workflows/sdk-java.yml', 'utf8'),
    );
    const sdkSteps = Object.values(sdkJava.jobs).flatMap(
      (job) => job.steps ?? [],
    );
    for (const name of [
      'Run Java SDK Checkstyle',
      'Run Managed Agent Server Checkstyle',
    ]) {
      const sibling = sdkSteps.find((candidate) => candidate.name === name);
      expect(sibling, name).toBeDefined();
      expect(step(name).run).toBe(sibling.run);
      expect(step(name)['working-directory']).toBe(
        sibling['working-directory'],
      );
    }
  });
});
