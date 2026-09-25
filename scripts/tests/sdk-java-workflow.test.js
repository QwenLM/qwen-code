import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/sdk-java.yml', 'utf8');
const managedHostedE2E = readFileSync(
  'scripts/run-managed-hosted-runtime-e2e.ts',
  'utf8',
);
const managedAgentServerE2E = readFileSync(
  'scripts/run-managed-agent-server-e2e.ts',
  'utf8',
);
const embeddedRuntimeBroker = readFileSync(
  'packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/EmbeddedRuntimeBroker.java',
  'utf8',
);
const job = (name) => {
  const start = workflow.indexOf(`  ${name}:`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};

const step = (block, name) => {
  const marker = `      - name: '${name}'`;
  const start = block.indexOf(marker);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const next = block.slice(start + 1).search(/\n {6}- name:/);
  return block.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe('SDK Java self-hosted workflow guards', () => {
  it('passes one Hosted Harness capability digest to the server and Java client', () => {
    expect(managedHostedE2E).toContain(
      'QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST: harnessCapabilityDigest',
    );
    expect(managedHostedE2E).toContain(
      'QWEN_MANAGED_HOSTED_E2E_CAPABILITY_DIGEST:',
    );
  });

  it('keeps the real-model server E2E compatible with the Hosted Harness profile', () => {
    expect(embeddedRuntimeBroker).toContain(
      'resolveWorkspaceId(broker, workspaceCwd)',
    );
    expect(managedAgentServerE2E).toContain(
      'modelProviders: { [selectedProviderGroup]: [selectedProvider] }',
    );
    expect(managedAgentServerE2E).toContain(
      "security: sourceSettings['security']",
    );
    expect(managedAgentServerE2E).toContain(
      'QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY: credentialKey',
    );
    expect(managedAgentServerE2E).toContain(
      "QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID: 'e2e-local-v1'",
    );
    for (const section of ['hooks', 'mcpServers', 'extensions', 'tools']) {
      expect(managedAgentServerE2E).not.toContain(
        `sourceSettings['${section}']`,
      );
    }
  });

  it('keeps the managed server runner portable and latency assertions stable', () => {
    expect(managedAgentServerE2E).toContain(
      "process.getuid?.() === 0 ? ['--user=root'] : []",
    );
    expect(managedAgentServerE2E).toContain(
      "'--no-defaults',\n      ...mysqldUserArguments,\n      '--initialize-insecure'",
    );
    expect(managedAgentServerE2E).toContain(
      'runtimeDelayMs >= modelBeforeRuntimeAssertionDelayMs',
    );
    expect(managedAgentServerE2E).toContain(
      'const modelBeforeRuntimeAssertionDelayMs = 20_000',
    );
  });

  it('keeps durable Session failover deterministic and isolated from real-model mode', () => {
    expect(managedAgentServerE2E).toContain(
      "} else if (argument === '--session-failover') {",
    );
    expect(managedAgentServerE2E).toContain(
      '...(durableFailover\n          ? {',
    );
    expect(managedAgentServerE2E).toContain(
      'QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL:',
    );
    expect(managedAgentServerE2E).toContain(
      "crashChild(harness.child, 'Hosted Harness A')",
    );
    expect(managedAgentServerE2E).toContain(
      "crashChild(spring.child, 'Spring Managed Agent Server A')",
    );
    expect(managedAgentServerE2E).toContain(
      'rmSync(harnessHome, { recursive: true, force: true })',
    );
    expect(managedAgentServerE2E).toContain('restoredFirstTurnContext: true');
    expect(managedAgentServerE2E).toContain(
      'oldHarnessDiskDeleted: !existsSync(harnessHome)',
    );
  });

  it('crashes at the durable tool-intent boundary and recovers the original execution', () => {
    expect(managedAgentServerE2E).toContain(
      "} else if (argument === '--inflight-failover') {",
    );
    expect(managedAgentServerE2E).toContain(
      "target.pathname.endsWith(':start')",
    );
    expect(managedAgentServerE2E).toContain("execution[1] !== 'PREPARED'");
    expect(managedAgentServerE2E).toContain(
      'recoveredExecution[0] !== originalExecutionCallId',
    );
    expect(managedAgentServerE2E).toContain(
      'initialModelRequests.length !== 1',
    );
    expect(managedAgentServerE2E).toContain(
      'sideEffectBytes !== inflightSideEffectContent',
    );
    expect(managedAgentServerE2E).toContain('physicalToolExecutions: 1');
  });

  it.each(['test', 'daemon-e2e'])('protects the %s job', (name) => {
    const block = job(name);
    for (const fragment of [
      "github.repository == ''QwenLM/qwen-code''",
      'github.event.pull_request.head.repo.full_name == github.repository',
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != ''true''",
      // Write-access fork authors route to ECS too; the association list is
      // the repo's established trusted set. Negative associations (CONTRIBUTOR,
      // NONE, '') fail contains() and stay hosted.
      'contains(fromJSON(\'\'["OWNER","MEMBER","COLLABORATOR"]\'\'), github.event.pull_request.author_association)',
      'fromJSON(\'\'["self-hosted", "linux", "x64", "ecs-qwen"]\'\')',
      "format('refs/pull/{0}/head', github.event.pull_request.number)",
      "EXPECTED_SHA: '${{ github.event.pull_request.head.sha }}'",
      'git merge-base --is-ancestor "${EXPECTED_SHA}" HEAD',
      'exit 1',
    ]) {
      expect(block).toContain(fragment);
    }
  });

  it('serializes latency-sensitive tests on each physical ECS host', () => {
    const block = job('test');
    expect(block).toContain(
      'if: "${{ runner.environment == \'self-hosted\' }}"',
    );
    expect(block).toContain(
      'exec 9>"${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"',
    );
    expect(block).toContain('flock --wait 1200 9');
    expect(block).toContain(
      '::error::sdk-java host lock not acquired within 20 minutes',
    );
    expect(block).toContain(
      'if: "${{ runner.environment == \'github-hosted\' }}"',
    );
  });

  it('runs Runtime Broker tests from the sibling module on self-hosted Java 21', () => {
    const block = step(job('test'), 'Run Java SDK tests (self-hosted)');
    expect(block).toContain("working-directory: 'packages/sdk-java/qwencode'");
    expect(block).toContain("MATRIX_JAVA: '${{ matrix.java }}'");
    expect(block).toContain(
      'mvn --batch-mode --no-transfer-progress clean test\n' +
        '          if [ "${MATRIX_JAVA}" = "21" ]; then\n' +
        '            cd ../runtime-broker\n' +
        '            mvn --batch-mode --no-transfer-progress clean test\n' +
        '          fi',
    );
  });

  it('runs the Managed Hosted Runtime E2E on JDK 21 while the daemon E2E stays on 11', () => {
    const block = job('daemon-e2e');
    expect(block).toContain(
      'java-version: |-\n            21\n            11\n',
    );
    expect(step(block, 'Run Managed Hosted Runtime E2E')).toContain(
      "JAVA_HOME: '${{ env.JAVA_HOME_21_X64 }}'",
    );
    expect(step(block, 'Run Java daemon E2E')).not.toContain('JAVA_HOME');
  });

  it.each(['test', 'daemon-e2e'])(
    'keeps setup-java Maven files job-local in the %s job',
    (name) => {
      const block = job(name);
      expect(block).toContain(
        "settings-path: '${{ runner.temp }}/setup-java-m2'",
      );
      expect(
        block.match(
          /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml'/g,
        ),
      ).toHaveLength(name === 'test' ? 6 : 2);
      expect(block).not.toContain('Drop shared Maven toolchains.xml');
      expect(block).not.toContain('rm -f "${HOME}/.m2/toolchains.xml"');
    },
  );
});
