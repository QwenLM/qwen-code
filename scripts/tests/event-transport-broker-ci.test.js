/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The MQ2d EventTransport broker gates span four files that must agree: the
// SDK Java workflow job, scripts/rocketmq-lite-broker.sh that provisions the
// broker, the event-transport-broker-gates Maven profile, and the gate class
// with the server's property defaults. A name or budget that drifts in one of
// them fails the gate only on CI, after a broker boot, or not at all.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/sdk-java.yml', 'utf8'));
const job = workflow.jobs['event-transport-broker'];
const step = (name) => {
  const found = job.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
};
const script = readFileSync('scripts/rocketmq-lite-broker.sh', 'utf8');
const pom = readFileSync('packages/managed-agent-server/pom.xml', 'utf8');
const profile = pom
  .split('<id>event-transport-broker-gates</id>')[1]
  .split('</profile>')[0];
const server = 'packages/managed-agent-server/src';
const properties = readFileSync(
  `${server}/main/java/com/alibaba/qwen/code/managedagent/config/ManagedAgentProperties.java`,
  'utf8',
);
const gate = readFileSync(
  `${server}/test/java/com/alibaba/qwen/code/managedagent/EventTransportBrokerGate.java`,
  'utf8',
);

const scriptDefault = (name) =>
  new RegExp(`^${name}="\\$\\{${name}:-([^}]*)\\}"$`, 'm').exec(script)?.[1];
const propertyDefault = (field) =>
  new RegExp(`private String ${field} =\\s*"([^"]+)";`).exec(properties)?.[1];
const gateConstant = (name) =>
  new RegExp(`static final String ${name} = "([^"]+)";`).exec(gate)?.[1];

describe('EventTransport broker gates CI', () => {
  it('runs the gate profile and checks that the gate class ran', () => {
    const run = step('Verify the EventTransport broker gates').run;
    expect(run).toContain('-Pevent-transport-broker-gates');
    for (const property of ['endpoints', 'topic', 'normal-topic']) {
      expect(run).toContain(`-Dqwen.gate.rocketmq.${property}=`);
    }
    expect(run).toContain(
      'node scripts/check-failsafe-reports.js event-transport packages/managed-agent-server',
    );
  });

  it('runs only the gate class, never the unit suite, and fails on no tests', () => {
    expect(profile).toContain(
      '<include>**/EventTransportBrokerGate.java</include>',
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
    const verify = step('Verify the EventTransport broker gates');
    expect(verify['timeout-minutes'] * 60).toBeGreaterThan(fork);
    const capped = job.steps
      .map((candidate) => candidate['timeout-minutes'] ?? 0)
      .reduce((sum, minutes) => sum + minutes, 0);
    expect(job['timeout-minutes']).toBeGreaterThan(capped);
  });

  it('always stops the broker it started and keeps its evidence', () => {
    for (const name of [
      'Upload broker gate reports',
      'Stop the RocketMQ cluster',
    ]) {
      expect(step(name).if).toContain('always()');
      expect(step(name).if).toContain("steps.broker.outcome != 'skipped'");
    }
    expect(step('Stop the RocketMQ cluster').run).toBe(
      'scripts/rocketmq-lite-broker.sh stop',
    );
    expect(step('Stop the RocketMQ cluster').env.RMQ_WORK_DIR).toBe(
      step('Start the RocketMQ LiteTopic cluster').env.RMQ_WORK_DIR,
    );
  });

  it('routes like the MariaDB lane, with the JDK 17 the broker needs', () => {
    // The evaluated routing matrix lives in ci-runner-routing.test.mjs.
    expect(job['runs-on']).toBe(workflow.jobs['mysql-integration']['runs-on']);
    const java = step('Set up Java').with['java-version'];
    expect(String(java).split('\n')).toEqual(['17', '21']);
  });

  it('boots the cluster on free ports chosen for this job', () => {
    // A pool host runs many jobs at once: the script's fixed defaults would
    // collide between them, so every port it binds comes from the job env.
    const names = [
      'RMQ_NAMESRV_PORT',
      'RMQ_BROKER_PORT',
      'RMQ_PROXY_GRPC_PORT',
      'RMQ_PROXY_REMOTING_PORT',
    ];
    for (const name of names) expect(scriptDefault(name)).toBeDefined();
    const choose = step('Choose RocketMQ ports');
    const order = job.steps.map((candidate) => candidate.name);
    expect(order.indexOf('Choose RocketMQ ports')).toBeLessThan(
      order.indexOf('Start the RocketMQ LiteTopic cluster'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'rmq-ports-'));
    try {
      const envFile = join(dir, 'github_env');
      writeFileSync(envFile, '');
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', choose.run], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ENV: envFile },
      });
      expect(result.status, result.stderr).toBe(0);
      const chosen = Object.fromEntries(
        readFileSync(envFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('=')),
      );
      expect(Object.keys(chosen).sort()).toEqual([...names].sort());
      const ports = Object.values(chosen).map(Number);
      expect(new Set(ports).size).toBe(names.length);
      // The broker also binds listenPort - 2 (fast channel) and + 1 (HA).
      const broker = Number(chosen.RMQ_BROKER_PORT);
      expect(ports).not.toContain(broker - 2);
      expect(ports).not.toContain(broker + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const verify = step('Verify the EventTransport broker gates').run;
    expect(verify).toContain(
      '-Dqwen.gate.rocketmq.endpoints=127.0.0.1:${RMQ_PROXY_GRPC_PORT}',
    );
    const text = JSON.stringify(job);
    for (const name of names) {
      expect(text).not.toContain(scriptDefault(name));
    }
  });

  it('still runs the gate on its only live triggers', () => {
    // Keep both daily coverage and the release caller after leaving PR CI.
    expect(Object.keys(workflow.on).sort()).toEqual([
      'schedule',
      'workflow_call',
      'workflow_dispatch',
    ]);
    expect(workflow.on.schedule).toContainEqual({ cron: expect.any(String) });
  });

  it('provisions every group the server and the gate subscribe in', () => {
    const groups = scriptDefault('RMQ_GROUPS').split(' ');
    for (const field of [
      'capabilityProbeGroup',
      'wakeBootstrapGroup',
      'ownerGroup',
    ]) {
      expect(groups).toContain(propertyDefault(field));
    }
    const start = step('Start the RocketMQ LiteTopic cluster').env;
    expect(start.RMQ_EXTRA_GROUPS).toBe(gateConstant('ORACLE_GROUP'));
    expect(start.RMQ_NORMAL_GROUPS).toBe(gateConstant('NORMAL_PROBE_GROUP'));
    const run = step('Verify the EventTransport broker gates').run;
    expect(run).toContain(
      `-Dqwen.gate.rocketmq.topic=${scriptDefault('RMQ_TOPIC')}`,
    );
    expect(run).toContain(
      `-Dqwen.gate.rocketmq.normal-topic=${start.RMQ_NORMAL_TOPIC}`,
    );
    expect(run).toContain(
      '-Dqwen.gate.rocketmq.endpoints=127.0.0.1:${RMQ_PROXY_GRPC_PORT}',
    );
  });

  // The proxy refuses a lite topic name outside this pattern (code 40020);
  // Session ids are UUIDs and pass it, and so must the fixed names.
  it('keeps the fixed lite topic names within the proxy rule', () => {
    for (const name of [
      propertyDefault('wakeBootstrapLiteTopic'),
      /CAPABILITY_PROBE_LITE = "([^"]+)"/.exec(
        readFileSync(
          `${server}/main/java/com/alibaba/qwen/code/managedagent/config/EventTransportConfiguration.java`,
          'utf8',
        ),
      )[1],
    ]) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
});
