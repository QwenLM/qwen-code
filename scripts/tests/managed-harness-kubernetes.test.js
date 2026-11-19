/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { imageBuildPlan } from '../build-managed-harness-images.mjs';
import {
  eligibleWorker,
  renderQualification,
} from '../render-managed-harness-kubernetes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = 'a'.repeat(40);
const image = `example.test/harness@sha256:${'b'.repeat(64)}`;
const nodes = {
  items: [1, 2].map((id) => ({
    metadata: {
      name: `business-${id}`,
      uid: `node-${id}`,
      labels: { 'kubernetes.io/hostname': `business-${id}` },
    },
    spec: {},
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  })),
};
const config = {
  namespace: 'qualification',
  runId: 'qualification-1',
  javaNamespace: 'control',
  javaServiceAccount: 'managed-agent-server',
  sourceSha: sha,
  harnessImage: image,
  envoyImage: image.replace('harness@', 'envoy@'),
  nodeNames: ['business-1', 'business-2'],
  capabilityDigest: `sha256:${'c'.repeat(64)}`,
  brokerUrl: 'https://broker.example.test',
  modelBaseUrl: 'https://model.example.test/v1',
  modelId: 'qualification-model',
  httpsPorts: [443, 8443],
};

describe('qualification image build planning', () => {
  it('pins every image to one source and plans without executing a builder', () => {
    const plan = imageBuildPlan(sha, 'example.test/qualification');
    expect(plan.buildStatus).toBe('PLANNED_NOT_EXECUTED');
    expect(plan.publishedDigests).toEqual({});
    expect(plan.commands).toHaveLength(3);
    for (const args of plan.commands) {
      expect(args).toContain(`org.opencontainers.image.revision=${sha}`);
      expect(args.slice(0, 3)).toEqual(['build', '--platform', 'linux/amd64']);
      expect(args.at(-1)).toBe('.');
    }
    expect(plan.commands[2]).toContain(`HARNESS_IMAGE=${plan.images.harness}`);
    expect(plan.commands[2]).toContain(`SERVER_IMAGE=${plan.images.java}`);
  });

  it.each([
    ['main', 'example.test/repo'],
    [sha, '--push'],
    [sha, 'repo\n--push'],
  ])('rejects mutable source or unsafe image input %s', (source, prefix) => {
    expect(() => imageBuildPlan(source, prefix)).toThrow();
  });

  it('default CLI mode never invokes Docker or Git and does not publish', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'harness-build-plan-'));
    try {
      const output = path.join(temp, 'plan.json');
      execFileSync(
        process.execPath,
        [
          'scripts/build-managed-harness-images.mjs',
          '--source-sha',
          sha,
          '--image-prefix',
          'example.test/repo',
          '--output',
          output,
        ],
        { cwd: root, env: { ...process.env, PATH: '' }, stdio: 'pipe' },
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        buildStatus: 'PLANNED_NOT_EXECUTED',
        publishedDigests: {},
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'builds only an immutable archive and excludes untracked credentials',
    () => {
      const temp = mkdtempSync(path.join(os.tmpdir(), 'harness-archive-'));
      try {
        const repo = path.join(temp, 'repo'),
          bin = path.join(temp, 'bin');
        mkdirSync(repo);
        mkdirSync(bin);
        const dockerfile = path.join(
          repo,
          'packages/managed-agent-server/distribution/kubernetes/qualification/Dockerfile',
        );
        mkdirSync(path.dirname(dockerfile), { recursive: true });
        writeFileSync(dockerfile, 'FROM fixture\n');
        execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'pipe' });
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Qualification Fixture',
            '-c',
            'user.email=qualification@example.test',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '--quiet',
            '-m',
            'fixture',
          ],
          { cwd: repo, stdio: 'pipe' },
        );
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim();
        writeFileSync(path.join(repo, 'private-token'), 'DO_NOT_ARCHIVE');
        const docker = path.join(bin, 'docker'),
          log = path.join(temp, 'docker.jsonl');
        writeFileSync(
          docker,
          `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.QWEN_DOCKER_LOG,JSON.stringify({args:process.argv.slice(2),files:fs.readdirSync('.', {recursive:true})})+'\\n');\n`,
        );
        chmodSync(docker, 0o700);
        const output = path.join(temp, 'images.json');
        execFileSync(
          process.execPath,
          [
            'scripts/build-managed-harness-images.mjs',
            '--source-sha',
            revision,
            '--image-prefix',
            'example.test/qualification',
            '--output',
            output,
            '--execute',
          ],
          {
            cwd: root,
            stdio: 'pipe',
            env: {
              ...process.env,
              GIT_DIR: path.join(repo, '.git'),
              PATH: `${bin}:${process.env.PATH}`,
              QWEN_DOCKER_LOG: log,
            },
          },
        );
        const builds = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(builds).toHaveLength(3);
        for (const build of builds) {
          expect(build.args[0]).toBe('build');
          expect(build.files).not.toContain('private-token');
          expect(build.files).not.toContain('.git');
        }
        expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
          sourceSha: revision,
          buildStatus: 'BUILT_NOT_PUBLISHED',
          publishedDigests: {},
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});

describe('existing-node deployment rendering', () => {
  it('uses real v3 publication for foreground Shell across Pods', () => {
    const directory = path.join(
      root,
      'packages/managed-agent-server/distribution/kubernetes/qualification',
    );
    const settings = parse(
      readFileSync(path.join(directory, 'server.example.yaml'), 'utf8'),
    ).qwen['managed-agent'];
    expect(settings.harness['workspace-shell-enabled']).toBe(true);
    expect(settings['tool-publication']).toMatchObject({
      enabled: true,
      'service-base-url': '${QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL}',
      'oss-endpoint': '${QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_ENDPOINT}',
      'oss-region': '${QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_REGION}',
      'oss-bucket': '${QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_BUCKET}',
      'operation-timeout': '10s',
      'claim-timeout': '3s',
    });
    const envoy = parse(
      readFileSync(path.join(directory, 'server-envoy.yaml'), 'utf8'),
    );
    const routes =
      envoy.static_resources.listeners[0].filter_chains[0].filters[0]
        .typed_config.route_config.virtual_hosts[0].routes;
    const index = routes.findIndex(
      (route) =>
        route.match.prefix === '/internal/managed-tool-publications/v1/',
    );
    expect(index).toBeGreaterThan(0);
    expect(routes[0].direct_response.status).toBe(403);
    expect(routes[index].route).toMatchObject({
      cluster: 'store',
      host_rewrite_literal: '127.0.0.1:4183',
      retry_policy: { retry_on: '', num_retries: 0 },
    });
  });
  it('lets the local Broker derive its canonical default Workspace identity', () => {
    const settings = parse(
      readFileSync(
        path.join(
          root,
          'packages/managed-agent-server/distribution/kubernetes/qualification/server.example.yaml',
        ),
        'utf8',
      ),
    ).qwen['managed-agent'];
    expect(settings['session-store']).not.toHaveProperty('workspace-id');
    expect(settings['runtime-broker']).not.toHaveProperty('workspace-id');
    expect(settings['runtime-broker']['workspace-cwd']).toBe(
      '/data/default-workspace',
    );
    expect(settings['runtime-broker']['workspace-creation-root']).toBe(
      '/data/workspaces',
    );
  });
  it('fills actual templates without Secrets, HPA or infrastructure resources', () => {
    const resources = renderQualification(config, nodes);
    expect(
      resources.some((item) =>
        [
          'Secret',
          'HorizontalPodAutoscaler',
          'PersistentVolumeClaim',
          'Node',
        ].includes(item.kind),
      ),
    ).toBe(false);
    const deployment = resources.find((item) => item.kind === 'Deployment');
    const pod = deployment.spec.template.spec;
    expect(deployment.spec.replicas).toBe(2);
    expect(deployment.spec.strategy.rollingUpdate).toEqual({
      maxUnavailable: 0,
      maxSurge: 1,
    });
    expect(pod.tolerations).toBeUndefined();
    expect(pod.priorityClassName).toBe(config.runId);
    expect(
      resources.find((item) => item.kind === 'PriorityClass'),
    ).toMatchObject({
      metadata: { name: config.runId },
      value: -1000,
      globalDefault: false,
      preemptionPolicy: 'Never',
    });
    expect(
      pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
        .nodeSelectorTerms,
    ).toEqual([
      {
        matchFields: [
          { key: 'metadata.name', operator: 'In', values: ['business-1'] },
        ],
      },
      {
        matchFields: [
          { key: 'metadata.name', operator: 'In', values: ['business-2'] },
        ],
      },
    ]);
    expect(pod.topologySpreadConstraints[0]).toMatchObject({
      maxSkew: 1,
      minDomains: 2,
      whenUnsatisfiable: 'DoNotSchedule',
    });
    expect(pod.containers[0].readinessProbe.exec.command).toEqual([
      'node',
      '/opt/qwen/harness-probe.mjs',
      'ready',
    ]);
    expect(pod.containers[0].image).toBe(config.harnessImage);
    expect(pod.initContainers[0]).toMatchObject({
      restartPolicy: 'Always',
      image: config.envoyImage,
    });
    expect(
      resources.find((item) => item.kind === 'RoleBinding').subjects[0],
    ).toEqual({
      kind: 'ServiceAccount',
      name: 'managed-agent-server',
      namespace: 'control',
    });
    const policy = resources.find((item) => item.kind === 'NetworkPolicy');
    expect(policy.spec.ingress[0].from[0]).toEqual({
      podSelector: { matchLabels: { app: 'managed-agent-server' } },
      namespaceSelector: {
        matchLabels: { 'kubernetes.io/metadata.name': 'control' },
      },
    });
    expect(policy.spec.egress[1].ports).toEqual([
      { protocol: 'TCP', port: 443 },
      { protocol: 'TCP', port: 8443 },
    ]);
    for (const item of resources)
      expect(item.metadata.labels['qwen.ai/qualification-run']).toBe(
        config.runId,
      );
  });

  it.each([
    { harnessImage: 'example.test/harness:latest' },
    { envoyImage: 'example.test/envoy:latest' },
    { nodeNames: ['business-1', 'business-1'] },
    { sourceSha: 'main' },
    { brokerUrl: 'http://broker.example.test' },
    { modelBaseUrl: 'https://user:password@model.example.test/v1' },
    { namespace: 'qualification/other' },
  ])('refuses incomplete or unsafe rendering inputs %j', (override) => {
    expect(() =>
      renderQualification({ ...config, ...override }, nodes),
    ).toThrow();
  });

  it.each([
    (node) => {
      node.metadata.labels = { 'alibabacloud.com/system-nodepool': 'true' };
    },
    (node) => {
      node.spec.taints = [
        { key: 'CriticalAddonsOnly', value: 'true', effect: 'NoSchedule' },
      ];
    },
    (node) => {
      node.spec.unschedulable = true;
    },
    (node) => {
      node.status.conditions[0].status = 'False';
    },
    (node) => {
      node.metadata.deletionTimestamp = '2026-10-25T00:00:00Z';
    },
  ])('refuses a reserved or unavailable selected worker', (mutate) => {
    const inventory = structuredClone(nodes);
    mutate(inventory.items[0]);
    expect(eligibleWorker(inventory.items[0])).toBe(false);
    expect(() => renderQualification(config, inventory)).toThrow();
  });
});

function preflightFixture() {
  const resources = renderQualification(config, nodes);
  const deployment = resources.find((item) => item.kind === 'Deployment');
  deployment.metadata = {
    ...deployment.metadata,
    uid: 'deployment-current',
    generation: 3,
    annotations: { 'deployment.kubernetes.io/revision': '2' },
  };
  deployment.status = {
    observedGeneration: 3,
    replicas: 2,
    updatedReplicas: 2,
    readyReplicas: 2,
    availableReplicas: 2,
  };
  return {
    cluster: { metadata: { uid: 'selected-cluster' } },
    nodes: structuredClone(nodes),
    namespace: {
      metadata: {
        uid: 'namespace-current',
        labels: { 'qwen.ai/qualification-run': config.runId },
      },
    },
    deployment,
    priorityclass: resources.find((item) => item.kind === 'PriorityClass'),
    replicasets: {
      items: [
        {
          metadata: {
            uid: 'replicaset-current',
            annotations: { 'deployment.kubernetes.io/revision': '2' },
            ownerReferences: [
              {
                kind: 'Deployment',
                uid: 'deployment-current',
                controller: true,
              },
            ],
          },
        },
      ],
    },
    pods: {
      items: [1, 2].map((id) => ({
        metadata: {
          uid: `pod-${id}`,
          name: `harness-${id}`,
          annotations: { 'qwen.ai/source-sha': sha },
          ownerReferences: [
            { kind: 'ReplicaSet', uid: 'replicaset-current', controller: true },
          ],
        },
        spec: {
          ...structuredClone(deployment.spec.template.spec),
          nodeName: `business-${id}`,
          tolerations: [
            {
              key: 'node.kubernetes.io/not-ready',
              operator: 'Exists',
              effect: 'NoExecute',
              tolerationSeconds: 300,
            },
          ],
        },
        status: {
          phase: 'Running',
          podIP: `10.0.0.${id}`,
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [
            { name: 'harness', imageID: image, restartCount: 0 },
          ],
        },
      })),
    },
    service: {
      metadata: { uid: 'service-current' },
      spec: { type: 'ClusterIP' },
    },
    endpointslices: {
      items: [
        {
          metadata: {
            namespace: config.namespace,
            ownerReferences: [{ kind: 'Service', uid: 'service-current' }],
          },
          ports: [{ name: 'https', protocol: 'TCP', port: 8443 }],
          endpoints: [1, 2].map((id) => ({
            conditions: { ready: true },
            addresses: [`10.0.0.${id}`],
            targetRef: {
              uid: `pod-${id}`,
              kind: 'Pod',
              namespace: config.namespace,
            },
          })),
        },
      ],
    },
    hpa: { items: [] },
  };
}

describe.skipIf(process.platform === 'win32')(
  'read-only live preflight through a kubectl fixture',
  () => {
    it.each([
      ['healthy metadata is not execution acceptance', () => {}, true],
      [
        'API omits the false global default field',
        (fixture) => {
          delete fixture.priorityclass.globalDefault;
        },
        true,
      ],
      [
        'preempting priority class',
        (fixture) => {
          fixture.priorityclass.preemptionPolicy = 'PreemptLowerPriority';
        },
        false,
      ],
      [
        'cluster default priority class',
        (fixture) => {
          fixture.priorityclass.globalDefault = true;
        },
        false,
      ],
      [
        'foreign priority class owner',
        (fixture) => {
          fixture.priorityclass.metadata.labels['qwen.ai/qualification-run'] =
            'foreign';
        },
        false,
      ],
      [
        'missing priority class on actual Pod',
        (fixture) => {
          delete fixture.pods.items[0].spec.priorityClassName;
        },
        false,
      ],
      [
        'reordered approved node alternatives',
        (fixture) => {
          for (const spec of [
            fixture.deployment.spec.template.spec,
            ...fixture.pods.items.map((pod) => pod.spec),
          ]) {
            spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.reverse();
          }
        },
        true,
      ],
      [
        'invalid multi-value node field selector',
        (fixture) => {
          fixture.deployment.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms =
            [
              {
                matchFields: [
                  {
                    key: 'metadata.name',
                    operator: 'In',
                    values: ['business-1', 'business-2'],
                  },
                ],
              },
            ];
        },
        false,
      ],
      [
        'foreign node alternative',
        (fixture) => {
          fixture.deployment.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.push(
            {
              matchFields: [
                { key: 'metadata.name', operator: 'In', values: ['other'] },
              ],
            },
          );
        },
        false,
      ],
      [
        'duplicate node alternative',
        (fixture) => {
          const terms =
            fixture.deployment.spec.template.spec.affinity.nodeAffinity
              .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms;
          terms[1] = structuredClone(terms[0]);
        },
        false,
      ],
      [
        'extra node field constraint',
        (fixture) => {
          fixture.deployment.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions =
            [{ key: 'unexpected', operator: 'Exists' }];
        },
        false,
      ],
      [
        'wrong cluster stops further reads',
        (fixture) => {
          fixture.cluster.metadata.uid = 'other-cluster';
        },
        false,
      ],
      [
        'reserved node stops further reads',
        (fixture) => {
          fixture.nodes.items[0].spec.taints = [
            { key: 'CriticalAddonsOnly', effect: 'NoSchedule' },
          ];
        },
        false,
      ],
      [
        'foreign namespace',
        (fixture) => {
          fixture.namespace.metadata.labels = {};
        },
        false,
      ],
      [
        'stale rollout',
        (fixture) => {
          fixture.deployment.status.updatedReplicas = 0;
        },
        false,
      ],
      [
        'foreign ReplicaSet',
        (fixture) => {
          fixture.pods.items[0].metadata.ownerReferences[0].uid = 'old';
        },
        false,
      ],
      [
        'mutable proxy image',
        (fixture) => {
          fixture.deployment.spec.template.spec.initContainers[0].image =
            'envoy:latest';
        },
        false,
      ],
      [
        'reserved-node toleration on actual Pod',
        (fixture) => {
          fixture.pods.items[0].spec.tolerations.push({
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          });
        },
        false,
      ],
      [
        'unrestricted node affinity',
        (fixture) => {
          fixture.deployment.spec.template.spec.affinity = {};
        },
        false,
      ],
      [
        'foreign discovery targets',
        (fixture) => {
          fixture.endpointslices.items[0].metadata.ownerReferences[0].uid =
            'other';
        },
        false,
      ],
      [
        'wrong discovery address',
        (fixture) => {
          fixture.endpointslices.items[0].endpoints[0].addresses = [
            '10.0.99.99',
          ];
        },
        false,
      ],
      [
        'wrong discovery port',
        (fixture) => {
          fixture.endpointslices.items[0].ports[0].port = 9443;
        },
        false,
      ],
      [
        'host workspace mounted in actual Pod',
        (fixture) => {
          fixture.pods.items[0].spec.volumes.push({
            name: 'tenant',
            hostPath: { path: '/workspaces' },
          });
        },
        false,
      ],
      [
        'Host workspace mount',
        (fixture) => {
          fixture.deployment.spec.template.spec.volumes.push({
            name: 'tenant',
            hostPath: { path: '/workspaces' },
          });
        },
        false,
      ],
      [
        'automatic scale-in',
        (fixture) => {
          fixture.hpa.items.push({
            spec: { scaleTargetRef: { name: 'qwen-harness' } },
          });
        },
        false,
      ],
    ])('%s', (_name, mutate, passed) => {
      const temp = mkdtempSync(path.join(os.tmpdir(), 'harness-preflight-'));
      try {
        const fixture = preflightFixture();
        mutate(fixture);
        const input = path.join(temp, 'fixture.json'),
          output = path.join(temp, 'report.json'),
          reads = path.join(temp, 'reads.jsonl'),
          kubectl = path.join(temp, 'kubectl');
        writeFileSync(input, JSON.stringify(fixture));
        writeFileSync(
          kubectl,
          `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[4]!=='get')process.exit(90);fs.appendFileSync(process.env.QWEN_PREFLIGHT_READS,JSON.stringify(a)+'\\n');const f=JSON.parse(fs.readFileSync(process.env.QWEN_PREFLIGHT_FIXTURE));console.log(JSON.stringify(f[a[5]==='namespace'&&a[6]==='kube-system'?'cluster':a[5]]));\n`,
        );
        chmodSync(kubectl, 0o700);
        const result = spawnSync(
          process.env.QWEN_TEST_PYTHON || 'python3',
          [
            'scripts/harness-kubernetes-preflight.py',
            '--kubectl',
            kubectl,
            '--context',
            'fixture',
            '--namespace',
            config.namespace,
            '--run-id',
            config.runId,
            '--source-sha',
            sha,
            '--cluster-uid',
            'selected-cluster',
            '--node',
            'business-1',
            '--node',
            'business-2',
            '--output',
            output,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 15000,
            env: {
              ...process.env,
              QWEN_PREFLIGHT_FIXTURE: input,
              QWEN_PREFLIGHT_READS: reads,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(passed ? 0 : 2);
        const report = JSON.parse(readFileSync(output, 'utf8'));
        expect(report.preflightPassed).toBe(passed);
        expect(report.executionAcceptance).toBe('NOT_RUN');
        const calls = readFileSync(reads, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(calls.every((args) => args[4] === 'get')).toBe(true);
        expect(calls.some((args) => args.includes('secrets'))).toBe(false);
        if (_name.startsWith('wrong cluster')) expect(calls).toHaveLength(1);
        if (_name.startsWith('reserved node')) expect(calls).toHaveLength(2);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  },
);
