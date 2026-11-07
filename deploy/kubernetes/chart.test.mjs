/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const render = async (args = [], baseInputs = inputs) => {
  const { stdout } = await execute(helm, [
    'template',
    'fixture',
    chart,
    ...baseInputs,
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
    serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_ID.value,
    createHash('sha256')
      .update(serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_CWD.value)
      .digest('hex')
      .slice(0, 16),
  );
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

test('LOCAL tools require a fixed node and persist private state outside Workspaces', async () => {
  await assert.rejects(
    render(['--set', 'runtime.enabled=true']),
    /Set runtime.nodeName/,
  );
  const objects = await render([
    '--set',
    'runtime.enabled=true',
    '--set',
    'runtime.nodeName=trusted-node',
    '--set',
    'runtime.storage.className=local',
  ]);
  const pod = find(objects, 'Deployment').spec.template.spec;
  assert.equal(pod.nodeName, undefined);
  assert.deepEqual(
    pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
      .nodeSelectorTerms[0].matchFields,
    [{ key: 'metadata.name', operator: 'In', values: ['trusted-node'] }],
  );
  assert.equal(pod.securityContext.fsGroupChangePolicy, 'OnRootMismatch');
  const [server, harness] = pod.containers;
  const serverEnv = env(server);
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_ID.value,
    createHash('sha256')
      .update(serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_CWD.value)
      .digest('hex')
      .slice(0, 16),
  );
  for (const key of [
    'QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED',
    'QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED',
    'QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED',
    'QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED',
    'QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS',
  ]) {
    assert.equal(serverEnv[key].value, 'true');
  }
  for (const key of [
    'QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY',
    'QWEN_MANAGED_AGENT_WORKSPACE_CHILD_AGENTS_ENABLED',
    'QWEN_MANAGED_AGENT_TOOL_PUBLICATION_ENABLED',
  ]) {
    assert.equal(serverEnv[key].value, 'false');
  }
  assert.equal(serverEnv.QWEN_MANAGED_AGENT_APPROVAL_MODE.value, 'default');
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY.value,
    '/runtime-data/state',
  );
  assert.equal(serverEnv.QWEN_HOME.value, '/runtime-data/home');
  assert.equal(
    serverEnv.QWEN_MANAGED_AGENT_WORKSPACE_CREATION_ROOT.value,
    '/workspaces',
  );
  assert.deepEqual(
    serverEnv.QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN.valueFrom,
    env(harness).QWEN_MANAGED_RUNTIME_BROKER_TOKEN.valueFrom,
  );
  assert.deepEqual(
    pod.volumes.find((volume) => volume.name === 'machine-id').hostPath,
    { path: '/etc/machine-id', type: 'File' },
  );
  assert.equal(
    server.volumeMounts.find((mount) => mount.name === 'machine-id').readOnly,
    true,
  );
  assert(!harness.volumeMounts.some((mount) => mount.name === 'runtime-data'));
  const claims = objects.filter(
    (object) => object.kind === 'PersistentVolumeClaim',
  );
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    assert.equal(claim.metadata.annotations['helm.sh/resource-policy'], 'keep');
    assert.equal(claim.spec.storageClassName, 'local');
  }
  const key = find(objects, 'Secret').data['runtime-credential-key'];
  assert.equal(
    Buffer.from(Buffer.from(key, 'base64').toString(), 'base64').length,
    32,
  );
});

test('WebShell keeps its fixed identity and signing key server-side', async () => {
  await assert.rejects(
    render(['--set', 'web.enabled=true']),
    /Set web.tenantId/,
  );
  const objects = await render([
    '--set',
    'web.enabled=true',
    '--set',
    'web.tenantId=tenant-a',
    '--set',
    'web.actorId=actor-a',
    '--set',
    'web.allowOrigins[0]=https://agent.example',
  ]);
  const pod = find(objects, 'Deployment').spec.template.spec;
  const web = pod.containers.find((container) => container.name === 'web');
  assert.equal(web.image, 'harness:test');
  assert.deepEqual(web.args, [
    'serve',
    '--managed-web-config',
    '/etc/qwen-web/config.json',
    '--hostname',
    '0.0.0.0',
    '--port',
    '4171',
    '--allow-origin',
    'https://agent.example',
  ]);
  const webEnv = env(web);
  assert.equal(
    webEnv.QWEN_SERVER_TOKEN.valueFrom.secretKeyRef.key,
    'web-token',
  );
  assert(!webEnv.OPENAI_API_KEY);
  assert(!webEnv.QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY);
  assert(
    !web.volumeMounts.some((mount) =>
      ['workspace', 'workspaces', 'runtime-data'].includes(mount.name),
    ),
  );
  const signingVolume = pod.volumes.find(
    (volume) => volume.name === 'web-signing-key',
  );
  assert.deepEqual(signingVolume.secret.items, [
    { key: 'auth-signing-key', path: 'auth-signing-key' },
  ]);
  const config = find(objects, 'ConfigMap');
  assert.deepEqual(JSON.parse(config.data['managed-web.json']), {
    apiUrl: 'http://127.0.0.1:8080',
    tenantId: 'tenant-a',
    actorId: 'actor-a',
    signingKeyFile: '/run/qwen-web/auth-signing-key',
  });
  assert(!JSON.stringify(config).includes('fixture-key'));
  const secret = find(objects, 'Secret');
  assert.notEqual(secret.data['web-token'], secret.data['auth-signing-key']);
  assert.match(web.readinessProbe.exec.command[2], /4171\/health/);
  const service = objects.find(
    (object) => object.kind === 'Service' && object.metadata.name === 'fixture',
  );
  assert.deepEqual(
    service.spec.ports.map((port) => port.port),
    [8080, 4171],
  );
});

test('numeric browser identities and model keys render as strings', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'qwen-helm-values-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const valuesFile = join(temporary, 'values.yaml');
  for (const value of [0, 123]) {
    await writeFile(
      valuesFile,
      `web:\n  enabled: true\n  tenantId: ${value}\n  actorId: ${value}\nmodel:\n  apiKey: ${value}\n`,
    );
    for (const args of [
      ['--values', valuesFile],
      [
        '--set',
        'web.enabled=true',
        '--set',
        `web.tenantId=${value}`,
        '--set',
        `web.actorId=${value}`,
        '--set',
        `model.apiKey=${value}`,
      ],
    ]) {
      const objects = await render(args, inputs.slice(0, -2));
      const config = JSON.parse(
        find(objects, 'ConfigMap').data['managed-web.json'],
      );
      assert.equal(config.tenantId, String(value));
      assert.equal(config.actorId, String(value));
      assert.equal(
        Buffer.from(
          find(objects, 'Secret').data['model-api-key'],
          'base64',
        ).toString(),
        String(value),
      );
    }
  }
});

test('missing, null or whitespace browser identities and keys fail closed', async () => {
  const web = [
    '--set',
    'web.enabled=true',
    '--set',
    'web.tenantId=tenant-a',
    '--set',
    'web.actorId=actor-a',
  ];
  for (const key of ['web.tenantId', 'web.actorId', 'model.apiKey']) {
    for (const [flag, value] of [
      ['--set', ''],
      ['--set', 'null'],
      ['--set-string', '  '],
    ]) {
      await assert.rejects(render([...web, flag, `${key}=${value}`]), (error) =>
        error.message.includes(`Set ${key}`),
      );
    }
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
  let retainedRuntime;
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
      '/api/v1/namespaces/test-space/persistentvolumeclaims/fixture-runtime':
        retainedRuntime,
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
  storedSecret.data['operator-note'] =
    Buffer.from('preserve-extra-key').toString('base64');
  const optional = [
    '--set',
    'runtime.enabled=true',
    '--set',
    'runtime.nodeName=trusted-node',
    '--set',
    'web.enabled=true',
    '--set',
    'web.tenantId=tenant-a',
    '--set',
    'web.actorId=actor-a',
  ];
  const enabled = find(
    await render([
      '--is-upgrade',
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
      ...optional,
    ]),
    'Secret',
  );
  for (const [key, value] of Object.entries(storedSecret.data)) {
    assert.equal(enabled.data[key], value);
  }
  assert(enabled.data['runtime-broker-token']);
  assert(enabled.data['runtime-credential-key']);
  assert(enabled.data['web-token']);
  storedSecret = enabled;
  const disabled = find(
    await render([
      '--is-upgrade',
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
    ]),
    'Secret',
  );
  assert.deepEqual(disabled.data, enabled.data);
  const external = ['--set', 'credentials.existingSecret=fixture-keys'];
  delete storedSecret.data['runtime-credential-key'];
  retainedRuntime = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'fixture-runtime' },
  };
  await assert.rejects(
    render([
      '--is-upgrade',
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
      ...optional,
    ]),
    /retained Runtime PVC is missing its credentials/,
  );
  await assert.rejects(
    render([
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
      ...optional,
      ...external,
    ]),
    /missing runtime-credential-key/,
  );
  storedSecret.data['runtime-credential-key'] =
    enabled.data['runtime-broker-token'];
  storedSecret.data['web-token'] = storedSecret.data['auth-signing-key'];
  await assert.rejects(
    render([
      '--dry-run=server',
      '--kubeconfig',
      kubeconfig,
      ...optional,
      ...external,
    ]),
    /web-token must differ/,
  );
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
