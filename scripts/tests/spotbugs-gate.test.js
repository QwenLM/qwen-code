/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const GATED_MODULES = ['runtime-broker', 'managed-agent-server'];

describe('SpotBugs gate witness', () => {
  // A Match whose only predicate is a wildcard class or package turns the
  // gate into a silent no-op: the build reports the same `BugInstance size
  // is 0` as a genuinely clean tree.
  it('rejects wildcard-only Match blocks in the per-module excludes files', () => {
    for (const mod of GATED_MODULES) {
      const xml = read(`packages/sdk-java/${mod}/spotbugs-excludes.xml`);
      for (const [, body] of xml.matchAll(/<Match>([\s\S]*?)<\/Match>/g)) {
        const specific =
          /<Bug\s+pattern="[^"]+"/.test(body) ||
          /<Method[\s/>]/.test(body) ||
          /<Field[\s/>]/.test(body) ||
          /<Class\s+name="(?!~)/.test(body) ||
          /<Package\s+name="(?!~)/.test(body);
        expect(
          specific,
          `packages/sdk-java/${mod}/spotbugs-excludes.xml: every <Match> ` +
            'needs a Bug pattern, a Method/Field, or a concrete (non-~) ' +
            'Class/Package name — wildcard-only blocks silence the gate',
        ).toBe(true);
      }
    }
  });

  // The staging installs only produce jars for the next module: a SpotBugs
  // rejection there aborts the job's real subject under a misleading step
  // name. The `clean verify` invocations are the gate's CI coverage and must
  // never carry the skip.
  it('keeps the gate on the enforcing sdk-java.yml invocations and off the staging installs', () => {
    const workflow = parse(read('.github/workflows/sdk-java.yml'));
    const steps = Object.values(workflow.jobs).flatMap(
      (job) => job.steps ?? [],
    );
    const byName = (name) => steps.filter((step) => step.name === name);

    const staging = byName('Install Managed Agent dependencies');
    expect(staging.length).toBe(2);
    for (const step of staging) {
      const brokerInstall = step.run
        .split('\n')
        .find((line) => line.includes('runtime-broker/pom.xml'));
      expect(brokerInstall).toContain('-Dspotbugs.skip=true');
    }

    const enforcing = [
      ...byName('Run Runtime Broker MySQL integration tests'),
      ...byName('Run Managed Agent tests, Checkstyle, and MySQL integration'),
      ...byName('Verify Hosted Java, Spring and MySQL processes'),
    ];
    expect(enforcing.length).toBe(3);
    for (const step of enforcing) {
      expect(step.run).toContain('verify');
      expect(step.run).not.toContain('spotbugs.skip');
    }

    // Global invariant: the skip lives nowhere else — not on a new or
    // renamed step, and not smuggled in through MAVEN_ARGS at any env level
    // (the mvn script reads that variable, so it would not show up in run).
    const envBlobs = [
      workflow.env,
      ...Object.values(workflow.jobs).map((job) => job.env),
      ...steps.map((step) => step.env),
    ];
    for (const env of envBlobs) {
      expect(JSON.stringify(env ?? {})).not.toContain('spotbugs.skip');
    }
    const withSkip = steps.filter((step) =>
      step.run?.includes('spotbugs.skip'),
    );
    expect(withSkip.map((step) => step.name)).toEqual([
      'Install Managed Agent dependencies',
      'Install Managed Agent dependencies',
    ]);
  });
});
