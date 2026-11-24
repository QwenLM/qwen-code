/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';

const templates = fileURLToPath(
  new URL(
    '../packages/managed-agent-server/distribution/kubernetes/',
    import.meta.url,
  ),
);
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function eligibleWorker(node) {
  const labels = node.metadata?.labels ?? {};
  return (
    !node.metadata?.deletionTimestamp &&
    !node.spec?.unschedulable &&
    labels['alibabacloud.com/system-nodepool'] !== 'true' &&
    !('node-role.kubernetes.io/control-plane' in labels) &&
    !('node-role.kubernetes.io/master' in labels) &&
    !(node.spec?.taints ?? []).some(
      (taint) =>
        taint.key === 'CriticalAddonsOnly' ||
        ['NoSchedule', 'NoExecute'].includes(taint.effect),
    ) &&
    !(node.status?.conditions ?? []).some(
      (condition) =>
        ['MemoryPressure', 'DiskPressure', 'PIDPressure'].includes(
          condition.type,
        ) && condition.status === 'True',
    ) &&
    (node.status?.conditions ?? []).some(
      (condition) => condition.type === 'Ready' && condition.status === 'True',
    )
  );
}

export function renderQualification(config, inventory) {
  for (const name of [
    'namespace',
    'runId',
    'javaNamespace',
    'javaServiceAccount',
  ]) {
    if (!dnsLabel.test(config[name] ?? '')) throw new Error(`Invalid ${name}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(config.sourceSha ?? ''))
    throw new Error('Invalid sourceSha');
  for (const name of ['harnessImage', 'envoyImage']) {
    if (
      !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/u.test(config[name] ?? '')
    )
      throw new Error(`Immutable ${name} is required`);
  }
  if (
    !Array.isArray(config.nodeNames) ||
    config.nodeNames.length !== 2 ||
    new Set(config.nodeNames).size !== 2
  )
    throw new Error(
      'Exactly two distinct existing business node names are required',
    );
  for (const name of config.nodeNames) {
    const node = inventory.items?.find((item) => item.metadata?.name === name);
    if (!node || !eligibleWorker(node))
      throw new Error(
        'Selected node is missing, reserved, tainted or not Ready',
      );
  }
  const hostnames = config.nodeNames.map(
    (name) =>
      inventory.items.find((item) => item.metadata.name === name).metadata
        .labels?.['kubernetes.io/hostname'],
  );
  if (hostnames.some((name) => !name) || new Set(hostnames).size !== 2)
    throw new Error('Two distinct hostname topology domains are required');
  if (!/^sha256:[a-f0-9]{64}$/u.test(config.capabilityDigest ?? ''))
    throw new Error('Invalid capabilityDigest');
  for (const name of ['brokerUrl', 'modelBaseUrl']) {
    const url = new URL(config[name]);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(`${name} requires a credential-free HTTPS URL`);
  }
  if (
    typeof config.modelId !== 'string' ||
    !config.modelId ||
    config.modelId.length > 128
  )
    throw new Error('Invalid modelId');
  if (
    !Array.isArray(config.httpsPorts) ||
    !config.httpsPorts.length ||
    !config.httpsPorts.every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    )
  )
    throw new Error('Actual HTTPS backend ports are required');
  const labels = { 'qwen.ai/qualification-run': config.runId };
  const namespace = {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.namespace,
      labels: { ...labels, 'pod-security.kubernetes.io/enforce': 'baseline' },
    },
  };
  const resources = [
    'harness-pool.yaml',
    'harness-service.yaml',
    'harness-pdb.yaml',
    'harness-network-policy.yaml',
    'discovery-rbac.yaml',
    'discovery-role-binding.yaml',
    'settings.example.yaml',
  ].map((name) => parse(readFileSync(path.join(templates, name), 'utf8')));
  for (const resource of resources) {
    resource.metadata.namespace = config.namespace;
    resource.metadata.labels = { ...resource.metadata.labels, ...labels };
  }
  const deployment = resources.find(
    (resource) => resource.kind === 'Deployment',
  );
  deployment.spec.template.metadata.labels = {
    ...deployment.spec.template.metadata.labels,
    ...labels,
  };
  deployment.spec.template.metadata.annotations = {
    'qwen.ai/source-sha': config.sourceSha,
  };
  const pod = deployment.spec.template.spec;
  pod.preemptionPolicy = 'Never';
  pod.priorityClassName = config.runId;
  pod.affinity = {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: config.nodeNames.map((name) => ({
          matchFields: [
            {
              key: 'metadata.name',
              operator: 'In',
              values: [name],
            },
          ],
        })),
      },
    },
  };
  pod.topologySpreadConstraints = [
    {
      maxSkew: 1,
      minDomains: 2,
      topologyKey: 'kubernetes.io/hostname',
      whenUnsatisfiable: 'DoNotSchedule',
      labelSelector: { matchLabels: { app: 'qwen-harness' } },
    },
  ];
  pod.containers.find((container) => container.name === 'harness').image =
    config.harnessImage;
  pod.initContainers.find((container) => container.name === 'mtls').image =
    config.envoyImage;
  const binding = resources.find((resource) => resource.kind === 'RoleBinding');
  binding.subjects[0] = {
    kind: 'ServiceAccount',
    name: config.javaServiceAccount,
    namespace: config.javaNamespace,
  };
  const network = resources.find(
    (resource) => resource.kind === 'NetworkPolicy',
  );
  if (config.javaNamespace !== config.namespace)
    network.spec.ingress[0].from[0].namespaceSelector = {
      matchLabels: { 'kubernetes.io/metadata.name': config.javaNamespace },
    };
  network.spec.egress[1].ports = config.httpsPorts.map((port) => ({
    protocol: 'TCP',
    port,
  }));
  const settings = resources.find(
    (resource) => resource.metadata.name === 'qwen-harness-settings',
  );
  settings.data['capability-digest'] = config.capabilityDigest;
  settings.data['broker-url'] = config.brokerUrl;
  const model = JSON.parse(settings.data['settings.json']);
  model.model.name = config.modelId;
  model.modelProviders.openai[0].id = config.modelId;
  model.modelProviders.openai[0].baseUrl = config.modelBaseUrl;
  settings.data['settings.json'] = JSON.stringify(model, null, 2);
  const envoy = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'qwen-harness-envoy',
      namespace: config.namespace,
      labels,
    },
    data: {
      'envoy.yaml': readFileSync(path.join(templates, 'envoy.yaml'), 'utf8'),
    },
  };
  const quota = {
    apiVersion: 'v1',
    kind: 'ResourceQuota',
    metadata: {
      name: 'qualification-ceiling',
      namespace: config.namespace,
      labels,
    },
    spec: {
      hard: {
        pods: '3',
        'requests.cpu': '4',
        'requests.memory': '4Gi',
        'limits.cpu': '9',
        'limits.memory': '10Gi',
        persistentvolumeclaims: '0',
        'services.loadbalancers': '0',
        'services.nodeports': '0',
      },
    },
  };
  const priority = {
    apiVersion: 'scheduling.k8s.io/v1',
    kind: 'PriorityClass',
    metadata: { name: config.runId, labels },
    value: -1000,
    globalDefault: false,
    preemptionPolicy: 'Never',
    description: 'Non-preempting priority for this qualification run only.',
  };
  return [namespace, quota, priority, ...resources, envoy];
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'node scripts/render-managed-harness-kubernetes.mjs --config render.json --output NEW_DIRECTORY',
      );
    else {
      if (!values.config || !values.output)
        throw new Error('config and output are required');
      const config = JSON.parse(readFileSync(values.config, 'utf8'));
      const inventory = JSON.parse(
        readFileSync(
          path.resolve(path.dirname(values.config), config.nodeInventoryFile),
          'utf8',
        ),
      );
      const resources = renderQualification(config, inventory);
      mkdirSync(values.output, { mode: 0o700 });
      writeFileSync(
        path.join(values.output, 'pool.yaml'),
        resources.map((resource) => stringify(resource)).join('---\n'),
        { mode: 0o600 },
      );
      writeFileSync(
        path.join(values.output, 'result.json'),
        JSON.stringify(
          {
            sourceSha: config.sourceSha,
            nodeNames: config.nodeNames,
            resources: resources.map((resource) => ({
              kind: resource.kind,
              name: resource.metadata.name,
            })),
            rendered: true,
            applied: false,
            executionAcceptance: 'NOT_RUN',
            limitations: [
              'Node inventory is an operator snapshot; verify live eligibility and rollout capacity before apply.',
              'Secrets, Pod-IP SAN certificates, Java client identity and actual HTTPS services are operator inputs.',
              'No HPA or paid infrastructure is created.',
            ],
          },
          null,
          2,
        ) + '\n',
      );
      console.log(
        JSON.stringify({
          rendered: true,
          applied: false,
          output: values.output,
        }),
      );
    }
  } catch {
    console.error(
      'Rendering failed: check explicit inputs, immutable images and eligible business nodes. No cluster writes performed.',
    );
    process.exitCode = 1;
  }
}
