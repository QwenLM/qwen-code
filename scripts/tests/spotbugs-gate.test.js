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

const GATED_MODULES = ['packages/managed-agent-server'];

describe('SpotBugs gate witness', () => {
  // A Match whose only predicate is a wildcard class or package turns the
  // gate into a silent no-op: the build reports the same `BugInstance size
  // is 0` as a genuinely clean tree.
  it('rejects wildcard-only Match blocks in the per-module excludes files', () => {
    for (const mod of GATED_MODULES) {
      const xml = read(`${mod}/spotbugs-excludes.xml`);
      for (const [, body] of xml.matchAll(/<Match>([\s\S]*?)<\/Match>/g)) {
        const specific =
          /<Bug\s+pattern="[^"]+"/.test(body) ||
          /<Method[\s/>]/.test(body) ||
          /<Field[\s/>]/.test(body) ||
          /<Class\s+name="(?!~)/.test(body) ||
          /<Package\s+name="(?!~)/.test(body);
        expect(
          specific,
          `${mod}/spotbugs-excludes.xml: every <Match> ` +
            'needs a Bug pattern, a Method/Field, or a concrete (non-~) ' +
            'Class/Package name — wildcard-only blocks silence the gate',
        ).toBe(true);
      }
    }
  });

  // The combined Server verification checks both Server and Broker classes.
  // The SDK is now its only staged dependency.
  it('keeps the gate on combined Server verification without staging a Broker artifact', () => {
    const workflow = parse(read('.github/workflows/sdk-java.yml'));
    const steps = Object.values(workflow.jobs).flatMap(
      (job) => job.steps ?? [],
    );
    const byName = (name) => steps.filter((step) => step.name === name);

    // Hosted MySQL, MariaDB and both EventTransport gate jobs each stage the
    // sibling modules before their own verify; the Hosted failover job
    // stages them before packaging the jar its arms run.
    const staging = byName('Install Managed Agent dependencies');
    expect(staging.length).toBe(5);
    for (const step of staging) {
      expect(step.run).toContain('packages/sdk-java/qwencode/pom.xml');
      expect(step.run).not.toContain('runtime-broker/pom.xml');
    }

    const enforcing = [
      ...byName('Run Managed Agent tests, Checkstyle, and MySQL integration'),
      ...byName('Verify Hosted Java, Spring and MySQL processes'),
      ...byName('Verify the EventTransport broker gates'),
      ...byName('Verify the EventTransport multi-node gates'),
    ];
    expect(enforcing.length).toBe(4);
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
    expect(withSkip).toEqual([]);
  });
});
