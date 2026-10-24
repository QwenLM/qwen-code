/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { parseAllDocuments } from 'yaml';

const execute = promisify(execFile);
const helm = process.env.HELM_BIN || 'helm';
const chart = fileURLToPath(new URL('./chart', import.meta.url));
const inputs = [
  '--namespace',
  'test-space',
  '--set',
  'server.image=server:test',
  '--set',
  'harness.image=harness:test',
  '--set',
  'model.id=test-model',
  '--set',
  'model.baseUrl=https://model.example/v1',
  '--set',
  'model.apiKey=fixture-key',
];
const render = async (args = []) => {
  const { stdout } = await execute(helm, [
    'template',
    'fixture',
    chart,
    ...inputs,
    ...args,
  ]);
  return parseAllDocuments(stdout).map((document) => {
    assert.deepEqual(document.errors, []);
    return document.toJSON();
  });
};
const find = (objects, kind) => objects.find((object) => object.kind === kind);
const env = (container) =>
  Object.fromEntries(container.env.map((item) => [item.name, item]));

test('renders isolated signed API and private Harness/Store with safe probes', async () => {
  const objects = await render();
  const deployment = find(objects, 'Deployment');
  assert.equal(deployment.spec.replicas, 1);
  assert.equal(deployment.spec.strategy.type, 'Recreate');
  const pod = deployment.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  const [server, harness] = pod.containers;
  const serverEnv = env(server);
  const harnessEnv = env(harness);
  assert.equal(serverEnv.QWEN_MANAGED_AGENT_AUTH_MODE.value, 'signed');
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_INTERNAL_SERVER_ADDRESS.value,
    '127.0.0.1',
  );
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL.value,
    'http://127.0.0.1:8081',
  );
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED.value,
    'false',
  );
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED.value,
    'false',
  );
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED.value,
    'false',
  );
  assert.deepEqual(
    serverEnv.QWEN_MANAGED_AGENT_HARNESS_TOKEN.valueFrom,
    harnessEnv.QWEN_SERVER_TOKEN.valueFrom,
  );
  assert.deepEqual(
    serverEnv.QWEN_MANAGED_AGENT_CAPABILITY_DIGEST.valueFrom,
    harnessEnv.QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST.valueFrom,
  );
  assert.equal(server.livenessProbe.httpGet.path, '/actuator/health/liveness');
  assert.equal(
    server.readinessProbe.httpGet.path,
    '/actuator/health/readiness',
  );
  assert.equal(
    serverEnv.MANAGEMENT_ENDPOINT_HEALTH_GROUP_READINESS_INCLUDE.value,
    'readinessState,db',
  );
  assert.match(
    harness.readinessProbe.exec.command[2],
    /127\.0\.0\.1:4170\/health/,
  );
  assert.match(
    harness.readinessProbe.exec.command[2],
    /Bearer.*QWEN_SERVER_TOKEN/,
  );
  assert.deepEqual(harness.startupProbe.exec, harness.livenessProbe.exec);
  for (const container of pod.containers) {
    assert.equal(container.securityContext.runAsNonRoot, true);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  }
  const api = objects.find(
    (object) => object.kind === 'Service' && object.metadata.name === 'fixture',
  );
  assert.deepEqual(
    api.spec.ports.map((port) => port.port),
    [8080],
  );
  assert.deepEqual(api.spec.selector, deployment.spec.selector.matchLabels);
});

test('secrets are distinct, retained and absent from model ConfigMap and argv', async () => {
  const objects = await render();
  const secret = find(objects, 'Secret');
  const decode = (name) => Buffer.from(secret.data[name], 'base64').toString();
  assert.equal(secret.metadata.annotations['helm.sh/resource-policy'], 'keep');
  assert(decode('auth-signing-key').length >= 32);
  assert.notEqual(
    decode('auth-signing-key'),
    decode('session-store-binding-key'),
  );
  assert.match(decode('capability-digest'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(decode('model-api-key'), 'fixture-key');
  const config = find(objects, 'ConfigMap');
  assert(!JSON.stringify(config).includes('fixture-key'));
  const settings = JSON.parse(config.data['settings.json']);
  assert.equal(settings.security.auth.selectedType, 'openai');
  assert.equal(settings.model.name, settings.modelProviders.openai[0].id);
  assert.equal(settings.modelProviders.openai[0].envKey, 'OPENAI_API_KEY');
  const containers = find(objects, 'Deployment').spec.template.spec.containers;
  for (const container of containers) {
    assert(!JSON.stringify(container.args ?? []).includes('fixture-key'));
  }
});

test('bundled MySQL persists data and grants the actual Flyway boot probe', async () => {
  const objects = await render([
    '--set',
    'mysql.storage.size=20Gi',
    '--set',
    'mysql.storage.className=fast',
    '--set',
    'imagePullSecrets[0].name=private-registry',
  ]);
  const mysql = find(objects, 'StatefulSet');
  assert.equal(
    mysql.spec.volumeClaimTemplates[0].spec.storageClassName,
    'fast',
  );
  assert.equal(
    mysql.spec.volumeClaimTemplates[0].spec.resources.requests.storage,
    '20Gi',
  );
  assert.match(
    find(objects, 'ConfigMap').data['mysql-init.sql'],
    /GRANT SELECT ON performance_schema\.user_variables_by_thread TO 'qwen'@'%'/,
  );
  const pod = mysql.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.match(pod.containers[0].readinessProbe.exec.command[2], /--user=qwen/);
  assert.match(
    pod.containers[0].readinessProbe.exec.command[2],
    /performance_schema\.user_variables_by_thread/,
  );
  assert.equal(
    pod.containers[0].volumeMounts.find((mount) => mount.name === 'data')
      .subPath,
    'mysql',
  );
  for (const object of objects.filter((item) =>
    ['Deployment', 'StatefulSet'].includes(item.kind),
  )) {
    assert.deepEqual(object.spec.template.spec.imagePullSecrets, [
      { name: 'private-registry' },
    ]);
  }
});

test('missing installation inputs or missing upgrade credentials fail closed', async () => {
  for (const key of [
    'server.image',
    'harness.image',
    'model.id',
    'model.baseUrl',
    'model.apiKey',
  ]) {
    await assert.rejects(render(['--set', `${key}=`]), /Set /);
  }
  await assert.rejects(render(['--is-upgrade']), /restore it before upgrading/);
  const external = await render([
    '--is-upgrade',
    '--set',
    'model.apiKey=',
    '--set',
    'credentials.existingSecret=operator-keys',
  ]);
  assert(!find(external, 'Secret'));
  assert.equal(
    env(find(external, 'Deployment').spec.template.spec.containers[0])
      .SPRING_DATASOURCE_PASSWORD.valueFrom.secretKeyRef.name,
    'operator-keys',
  );
});

test('server-side Helm rendering preserves every existing credential on upgrade', async (t) => {
  const original = find(await render(), 'Secret');
  let storedSecret = original;
  let retainedClaim;
  const visited = [];
  const peer = createServer((request, response) => {
    visited.push(request.url);
    const routes = {
      '/version': { major: '1', minor: '32', gitVersion: 'v1.32.0' },
      '/api': { kind: 'APIVersions', versions: ['v1'] },
      '/apis': { kind: 'APIGroupList', groups: [] },
      '/api/v1': {
        kind: 'APIResourceList',
        groupVersion: 'v1',
        resources: [
          {
            name: 'secrets',
            kind: 'Secret',
            namespaced: true,
            verbs: ['get', 'list'],
          },
          {
            name: 'persistentvolumeclaims',
            kind: 'PersistentVolumeClaim',
            namespaced: true,
            verbs: ['get', 'list'],
          },
        ],
      },
      '/api/v1/namespaces/test-space/secrets/fixture-keys': storedSecret,
      '/api/v1/namespaces/test-space/persistentvolumeclaims/data-fixture-mysql-0':
        retainedClaim,
    };
    const value = routes[request.url?.split('?')[0]];
    response.writeHead(value ? 200 : 404, {
      'Content-Type': 'application/json',
    });
    response.end(
      JSON.stringify(
        value ?? {
          kind: 'Status',
          status: 'Failure',
          reason: 'NotFound',
          code: 404,
        },
      ),
    );
  });
  await new Promise((ready) => peer.listen(0, '127.0.0.1', ready));
  const temporary = await mkdtemp(join(tmpdir(), 'qwen-helm-lookup-'));
  t.after(async () => {
    peer.closeAllConnections();
    await new Promise((done) => peer.close(done));
    await rm(temporary, { recursive: true, force: true });
  });
  const kubeconfig = join(temporary, 'config');
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      'current-context': 'fixture',
      clusters: [
        {
          name: 'fixture',
          cluster: { server: `http://127.0.0.1:${peer.address().port}` },
        },
      ],
      contexts: [
        { name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } },
      ],
      users: [{ name: 'fixture', user: {} }],
    }),
    { mode: 0o600 },
  );
  const upgraded = find(
    await render([
      '--is-upgrade',
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
      '--set',
      'model.apiKey=must-not-rotate',
    ]),
    'Secret',
  );
  assert(
    visited.includes('/api/v1/namespaces/test-space/secrets/fixture-keys'),
  );
  assert.deepEqual(upgraded.data, original.data);
  storedSecret = undefined;
  retainedClaim = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'data-fixture-mysql-0' },
  };
  await assert.rejects(
    render(['--dry-run=server', '--kubeconfig', kubeconfig]),
    /retained database PVC exists without its Secret/,
  );
});
