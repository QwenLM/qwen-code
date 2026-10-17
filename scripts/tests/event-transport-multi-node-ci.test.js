/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The MQ3 multi-node gates span the SDK Java workflow job, the
// event-transport-multi-node-gates Maven profile, the broker script and the
// gate class. A name, a path or a budget that drifts in one of them fails the
// gate only on CI, after a broker boot and four process starts, or not at all.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/sdk-java.yml', 'utf8'));
const job = workflow.jobs['event-transport-multi-node'];
const step = (name) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
};
const verify = () => step('Verify the EventTransport multi-node gates');
const pom = readFileSync('packages/managed-agent-server/pom.xml', 'utf8');
const profile = pom
  .split('<id>event-transport-multi-node-gates</id>')[1]
  .split('</profile>')[0];
const server = 'packages/managed-agent-server/src';
const properties = readFileSync(
  `${server}/main/java/com/alibaba/qwen/code/managedagent/config/ManagedAgentProperties.java`,
  'utf8',
);
const gate = readFileSync(
  `${server}/test/java/com/alibaba/qwen/code/managedagent/EventTransportMultiNodeGate.java`,
  'utf8',
);
const script = readFileSync('scripts/rocketmq-lite-broker.sh', 'utf8');

const gateConstant = (name) =>
  new RegExp(`static final String ${name} = "([^"]+)";`).exec(gate)?.[1];
const scriptDefault = (name) =>
  new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"$`, 'm').exec(script)?.[1];

describe('EventTransport multi-node gates CI', () => {
  it('runs the gate profile with every coordinate the gate requires', () => {
    const run = verify().run;
    expect(run).toContain('-Pevent-transport-multi-node-gates');
    const required = /for \(String name : List\.of\(([^)]*)\)\)/
      .exec(gate)[1]
      .match(/"[^"]+"/g)
      .map((quoted) => quoted.slice(1, -1));
    expect(required.length).toBeGreaterThan(0);
    for (const property of required) {
      expect(run).toContain(`-D${property}=`);
    }
    for (const property of [
      'qwen.gate.rocketmq.work-dir',
      'qwen.gate.faketime.library',
      'node.executable',
      'mysql.password',
    ]) {
      expect(run).toContain(`-D${property}=`);
    }
    expect(run).toContain(
      'node scripts/check-failsafe-reports.js event-transport-multi-node packages/managed-agent-server',
    );
  });

  it('runs only the gate class, never the unit suite, and fails on no tests', () => {
    expect(profile).toContain(
      '<include>**/EventTransportMultiNodeGate.java</include>',
    );
    expect(profile.match(/<include>/g)).toHaveLength(1);
    expect(profile).toContain('<failIfNoTests>true</failIfNoTests>');
    expect(profile).toMatch(
      /<artifactId>maven-surefire-plugin<\/artifactId>\s*<configuration><skipTests>true<\/skipTests>/,
    );
  });

  it('lets the gate step outlive its failsafe fork, and the job its steps', () => {
    const fork = Number(
      /<forkedProcessTimeoutInSeconds>(\d+)</.exec(profile)[1],
    );
    expect(verify()['timeout-minutes'] * 60).toBeGreaterThan(fork);
    const capped = job.steps
      .map((candidate) => candidate['timeout-minutes'] ?? 0)
      .reduce((sum, minutes) => sum + minutes, 0);
    expect(job['timeout-minutes']).toBeGreaterThan(capped);
  });

  // Awaitility ignores the interrupt a row's @Timeout sends, so the gate's
  // waits fail fast on it; the rows' ceilings must then fit the fork, or a
  // stalled class ends as a fork timeout with no per-row result (#13503).
  it("keeps the rows' timeouts within the failsafe fork", () => {
    const fork = Number(
      /<forkedProcessTimeoutInSeconds>(\d+)</.exec(profile)[1],
    );
    const rows = [...gate.matchAll(/@Timeout\((\d+)\)/g)].map((match) =>
      Number(match[1]),
    );
    expect(rows.length).toBe((gate.match(/@Test\b/g) ?? []).length);
    expect(rows.reduce((sum, seconds) => sum + seconds, 0)).toBeLessThan(fork);
    expect(gate).toContain('failFast(');
  });

  it('always stops the broker it started and keeps its evidence', () => {
    for (const name of [
      'Upload multi-node gate reports',
      'Stop the RocketMQ cluster',
    ]) {
      expect(step(name).if).toContain('always()');
      expect(step(name).if).toContain("steps.broker.outcome != 'skipped'");
    }
    expect(step('Stop the RocketMQ cluster').run).toBe(
      'scripts/rocketmq-lite-broker.sh stop',
    );
    const workDir = step('Start the RocketMQ LiteTopic cluster').env
      .RMQ_WORK_DIR;
    expect(step('Stop the RocketMQ cluster').env.RMQ_WORK_DIR).toBe(workDir);
    // The gate freezes the proxy whose pid file lives in that directory.
    expect(workDir).toBe('${{ runner.temp }}/rocketmq');
    expect(verify().run).toContain(
      '-Dqwen.gate.rocketmq.work-dir="${RUNNER_TEMP}/rocketmq"',
    );
    expect(step('Upload multi-node gate reports').with.path).toContain(
      'packages/managed-agent-server/target/mq3-multi-node/',
    );
  });

  it('runs on a GitHub-hosted runner with the JDK 17 the broker needs', () => {
    expect(job['runs-on']).toBe('ubuntu-latest');
    const java = step('Set up Java').with['java-version'];
    expect(String(java).split('\n')).toEqual(['17', '21']);
  });

  it('provisions the oracle group and points the gate at the bootstrap lane', () => {
    expect(
      step('Start the RocketMQ LiteTopic cluster').env.RMQ_EXTRA_GROUPS,
    ).toBe(gateConstant('ORACLE_GROUP'));
    expect(gateConstant('BOOTSTRAP_LITE_TOPIC')).toBe(
      /private String wakeBootstrapLiteTopic =\s*"([^"]+)";/.exec(
        properties,
      )[1],
    );
    const run = verify().run;
    expect(run).toContain(
      `-Dqwen.gate.rocketmq.topic=${scriptDefault('RMQ_TOPIC')}`,
    );
    expect(run).toContain(
      `-Dqwen.gate.rocketmq.endpoints=127.0.0.1:${scriptDefault('RMQ_PROXY_GRPC_PORT')}`,
    );
  });

  it('installs the libfaketime the clock-skew row preloads', () => {
    const library = /-Dqwen\.gate\.faketime\.library=(\S+)/.exec(
      verify().run,
    )[1];
    expect(step('Install libfaketime').run).toContain(`test -f ${library}`);
  });

  it('points the gate at the database the MySQL service creates', () => {
    const database = job.services.mysql.env.MYSQL_DATABASE;
    expect(verify().run).toContain(`/${database}?`);
    expect(verify().run).toContain(
      `-Dmysql.password=${job.services.mysql.env.MYSQL_ROOT_PASSWORD}`,
    );
  });
});
