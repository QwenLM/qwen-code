/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/qwen-autofix.yml', 'utf8');
const openAiProxyScript = readFileSync(
  '.github/scripts/openai-proxy.mjs',
  'utf8',
);
const checkBotCredentialsStep =
  workflow.match(
    /- name: 'Check bot credentials'[\s\S]*?(?=\n[ ]{6}- name: 'Set up Node.js \(hosted\)')/,
  )?.[0] ?? '';
const publishPrStep =
  workflow.match(
    /- name: 'Publish PR'[\s\S]*?(?=\n[ ]{6}- name: 'Withdraw claim on failure')/,
  )?.[0] ?? '';
const pushAndReportStep =
  workflow.match(
    /- name: 'Push and report'[\s\S]*?(?=\n[ ]{6}- name: 'Report dry-run \/ failure')/,
  )?.[0] ?? '';
const withdrawClaimStep =
  workflow.match(
    /- name: 'Withdraw claim on failure'[\s\S]*?(?=\n[ ]{2}# ==========)/,
  )?.[0] ?? '';
const prepareQwenCliSteps =
  workflow.match(
    /- name: 'Prepare Qwen Code CLI'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const assessCandidatesStep =
  workflow.match(
    /- name: 'Assess candidates'[\s\S]*?(?=\n[ ]{6}- name: 'Read decision')/,
  )?.[0] ?? '';
const developFixStep =
  workflow.match(
    /- name: 'Develop fix'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const triageAndAddressStep =
  workflow.match(
    /- name: 'Triage and address'[\s\S]*?(?=\n[ ]{6}- name: 'Verification gate')/,
  )?.[0] ?? '';
const resetAutofixWorkspaceSteps =
  workflow.match(
    /- name: 'Reset autofix workspace'[\s\S]*?(?=\n[ ]{6}- name: ')/g,
  ) ?? [];
const verificationGateSteps =
  workflow.match(/- name: 'Verification gate'[\s\S]*?(?=\n[ ]{6}- name: ')/g) ??
  [];
const openAiProxyLaunches =
  workflow.match(/node \.github\/scripts\/openai-proxy\.mjs/g) ?? [];

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

async function waitForProxy(infoPath, child) {
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  for (let i = 0; i < 50; i += 1) {
    if (existsSync(infoPath)) {
      return readFileSync(infoPath, 'utf8');
    }
    if (child.exitCode !== null) {
      throw new Error(`proxy exited early: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`proxy did not become ready: ${stderr}`);
}

describe('qwen-autofix workflow', () => {
  it('keeps ECS issue autofix limited to forced and ready-for-agent issues', () => {
    expect(workflow).toContain('autofixTier');
    expect(workflow).toContain('autofixTier: 0');
    expect(workflow).toContain('autofixTier: 1');
    expect(workflow).not.toContain('autofixTier: 2');
    expect(workflow).not.toContain('Tier 2 — unattended bugs');
    expect(workflow).not.toContain('filter_unattended_candidates()');
    expect(workflow).not.toContain('refresh_issue_comments()');
    expect(workflow).not.toContain('created:${MAX_CREATED}..${MIN_CREATED}');
    expect(workflow).not.toContain(
      'label:${BUG_LABEL} -label:${READY_FOR_AGENT_LABEL}',
    );
    expect(workflow).not.toContain('tier2.with-tier.json');
    expect(workflow).not.toContain('tier2-scan.json');
    // Forced issues must still honor the autofix skip/in-progress exclusion.
    expect(workflow).toContain(
      'any(. == "autofix/skip" or . == "autofix/in-progress")',
    );
    expect(workflow).toContain(
      '--search "is:open is:issue label:${READY_FOR_AGENT_LABEL} ${AUTOFIX_ISSUE_EXCLUDES}"',
    );
    expect(workflow).toContain('.[0:10] | map(. + {autofixTier: 1})');
  });

  it('keeps label-triggered issue routing guarded and diagnosable', () => {
    expect(workflow).toContain("issues:\n    types:\n      - 'labeled'");
    expect(workflow).toContain(
      "ISSUE_LABELS_JSON: '${{ toJSON(github.event.issue.labels.*.name) }}'",
    );
    expect(workflow).toContain(
      "SENDER_LOGIN: '${{ github.event.sender.login }}'",
    );
    expect(workflow).toContain("permissions:\n      contents: 'read'");
    expect(workflow).toContain(
      'gh api "repos/${REPO}/collaborators/${SENDER_LOGIN}/permission"',
    );
    expect(workflow).toContain(
      '::warning::Permission API call failed for ${SENDER_LOGIN}: ${api_error}',
    );
    expect(workflow).toContain("${sender_permission}\" == 'write'");
    expect(workflow).toContain("${sender_permission}\" == 'maintain'");
    expect(workflow).toContain("${sender_permission}\" == 'admin'");
    expect(workflow).toContain(
      "sender_permission='${sender_permission:-none}'",
    );
    expect(workflow).toContain(
      'issue event ignored: state_open=$([[ "${ISSUE_STATE}" == \'open\' ]]',
    );
    expect(workflow).toContain('bug=${issue_is_bug}');
    expect(workflow).toContain('ready=${issue_is_ready}');
    expect(workflow).toContain('trigger_label=${label_is_trigger}');
    expect(workflow).toContain('trigger_label=false label=');
    expect(workflow).toContain('sender_trusted=${sender_is_trusted}');
    expect(workflow).toContain("group: 'qwen-autofix-issue'");
    expect(workflow).toContain(
      '(.labels // []) | map(.name) as $labels | ($labels | index($ready))',
    );
    expect(workflow).toContain(
      '[[ "${EVENT_NAME}" != \'workflow_dispatch\' ]] && ! jq -e',
    );
    expect(workflow).toContain(
      '"${EVENT_NAME}" == \'workflow_dispatch\' && -n "${FORCED_ISSUE}"',
    );
    expect(workflow).toContain(
      '"${EVENT_NAME}" == \'workflow_dispatch\' && -n "${FORCED_PR}"',
    );
    expect(workflow).toContain(
      'is missing ${READY_FOR_AGENT_LABEL}; skipping.',
    );
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'type/bug')",
    );
    expect(workflow).not.toContain(
      "contains(github.event.issue.labels.*.name, 'status/ready-for-agent')",
    );
    expect(workflow).not.toContain('github.event.sender.author_association');
  });

  it('keeps forced issue routing bounded to open issues', () => {
    expect(workflow).toContain(
      '--json number,title,body,labels,createdAt,url,state',
    );
    expect(workflow).toContain(
      'Forced issue #${FORCED_ISSUE} is not open; skipping.',
    );
    expect(workflow).toContain(
      'elif [[ "$(jq -r \'.state // ""\' "${forced_issue_json}")" != \'OPEN\' ]]; then',
    );
  });

  it('keeps publish credential failures diagnosable', () => {
    expect(checkBotCredentialsStep.length).toBeGreaterThan(0);
    expect(publishPrStep.length).toBeGreaterThan(0);
    expect(pushAndReportStep.length).toBeGreaterThan(0);
    expect(withdrawClaimStep.length).toBeGreaterThan(0);
    expect(workflow.indexOf("- name: 'Check bot credentials'")).toBeLessThan(
      workflow.indexOf("- name: 'Set up Node.js (hosted)'"),
    );
    expect(checkBotCredentialsStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(checkBotCredentialsStep).toContain(
      'Failed to verify CI_DEV_BOT_PAT identity with gh api user',
    );
    expect(checkBotCredentialsStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}',
    );
    expect(publishPrStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(publishPrStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${publish_actor}',
    );
    expect(publishPrStep).toContain(
      'Failed to verify CI_DEV_BOT_PAT identity with gh api user',
    );
    expect(publishPrStep).toContain(
      'git config --local --unset-all http.https://github.com/.extraheader || true',
    );
    expect(pushAndReportStep).toContain(
      'GH_TOKEN="${GITHUB_TOKEN}" gh api user --jq \'.login\'',
    );
    expect(pushAndReportStep).toContain(
      'CI_DEV_BOT_PAT authenticates as ${bot_actor}',
    );
    expect(pushAndReportStep).toContain(
      'git config --local --unset-all http.https://github.com/.extraheader || true',
    );
    expect(withdrawClaimStep).toContain(
      "PUBLISH_OUTCOME: '${{ steps.publish.outcome }}'",
    );
    expect(withdrawClaimStep).toContain(
      'The agent produced and verified a fix, but publishing the PR failed.',
    );
    expect(withdrawClaimStep).toContain(
      'git push, PR creation, or PR comment error',
    );
  });

  it('runs heavy autofix jobs on dedicated runners without sandbox images', () => {
    expect(workflow).toContain('["self-hosted", "linux", "x64", "autofix"]');
    expect(workflow).toContain('AUTOFIX_ECS_RUNNER_DISABLED');
    expect(workflow).toContain(
      "RUNNER_ENVIRONMENT: '${{ runner.environment }}'",
    );
    expect(workflow).toContain('Unsupported runner environment');
    expect(prepareQwenCliSteps).toHaveLength(2);
    for (const step of prepareQwenCliSteps) {
      expect(step).toContain(
        'qwen_version="$(node -p "require(\'./package.json\').version")"',
      );
      expect(step).toContain(
        'exec node "${GITHUB_WORKSPACE}/dist/cli.js" "$@"',
      );
      expect(step).toContain('qwen-bin');
      expect(step).not.toContain('current_version="$(qwen --version');
      expect(step).not.toContain('Using pre-installed Qwen Code');
      expect(step).not.toContain('npm install -g');
    }
    expect(workflow).not.toContain('run_shell_command(node dist/cli.js)');
    expect(workflow).not.toContain('run_shell_command(npm run build)');
    expect(workflow).not.toContain('run_shell_command(npm run bundle)');
    expect(workflow).not.toContain('run_shell_command(npx vitest)');
    expect(workflow).toContain('Do not run project code,');
    expect(workflow).toContain(
      'workflow verification gate runs trusted checks after',
    );
    expect(workflow).toContain('"sandbox": false');
    expect(workflow).not.toContain('"sandbox": true');
    expect(workflow).not.toContain('QwenLM/qwen-code-action@');
    expect(workflow).not.toContain('Select issue sandbox image');
    expect(workflow).not.toContain('Select review sandbox image');
    expect(workflow).not.toContain('QWEN_SANDBOX_IMAGE');
    expect(workflow).not.toContain('ghcr.io/qwenlm/qwen-code');
    expect(workflow).not.toContain('npm view @qwen-code/qwen-code@latest');
    expect(workflow).not.toContain('KNOWN_BOTS');
  });

  it('uses the standard checkout action for autonomous runner jobs', () => {
    expect(workflow).toContain('actions/checkout@');
    expect(workflow).not.toContain('Checkout with retry');
    expect(workflow).not.toContain('Repository checkout failed on attempt');
  });

  it('surfaces assessment failures instead of turning them into green no-ops', () => {
    expect(assessCandidatesStep.length).toBeGreaterThan(0);
    expect(assessCandidatesStep).not.toContain('continue-on-error: true');
  });

  it('clears persistent autofix workdirs before using self-hosted runners', () => {
    expect(resetAutofixWorkspaceSteps).toHaveLength(2);
    expect(workflow).toContain("WORKDIR: '/tmp/autofix'");
    expect(workflow).toContain(
      "WORKDIR: '/tmp/autofix-review-${{ matrix.target.pr }}'",
    );
    expect(workflow).not.toContain("WORKDIR: '/tmp/autofix-review'");
    for (const step of resetAutofixWorkspaceSteps) {
      expect(step).toContain('rm -rf "${WORKDIR}"');
      expect(step).toContain('mkdir -p "${WORKDIR}"');
    }
    expect(workflow.indexOf("- name: 'Checkout'")).toBeLessThan(
      workflow.indexOf("- name: 'Reset autofix workspace'"),
    );
    expect(workflow.indexOf("- name: 'Reset autofix workspace'")).toBeLessThan(
      workflow.indexOf("- name: 'Find candidate issues'"),
    );
    expect(
      workflow.lastIndexOf("- name: 'Reset autofix workspace'"),
    ).toBeLessThan(workflow.indexOf("- name: 'Prepare branch and feedback'"));
  });

  it('runs qwen headless once in each agent step', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).toContain('qwen --yolo --prompt "${PROMPT}"');
      expect(step).not.toContain('for attempt in 1 2; do');
      expect(step).not.toContain('Qwen Code failed on attempt');
    }
    expect(assessCandidatesStep).toContain('rm -f "${WORKDIR}/decision.json"');
  });

  it('allows non-package fixes after deterministic verification', () => {
    expect(verificationGateSteps).toHaveLength(2);
    for (const step of verificationGateSteps) {
      expect(step).toContain('npm run build');
      expect(step).toContain('npm run typecheck');
      expect(step).toContain('npm run lint');
      expect(step).toContain(
        'No package changes detected; skipping package tests.',
      );
      expect(step).not.toContain('Fix does not touch any package');
      expect(step).not.toContain('PR does not touch any package');
    }
  });

  it('keeps real model credentials out of qwen subprocess environments', () => {
    const qwenSteps = [
      assessCandidatesStep,
      developFixStep,
      triageAndAddressStep,
    ];
    for (const step of qwenSteps) {
      expect(step.length).toBeGreaterThan(0);
      expect(step).not.toMatch(
        /^[ ]{10}OPENAI_API_KEY: '\$\{\{ secrets\.OPENAI_API_KEY \}\}'$/m,
      );
      expect(step).not.toMatch(
        /^[ ]{10}OPENAI_BASE_URL: '\$\{\{ secrets\.OPENAI_BASE_URL \}\}'$/m,
      );
      expect(step).toContain(
        "QWEN_UPSTREAM_OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}'",
      );
      expect(step).toContain(
        "QWEN_UPSTREAM_OPENAI_BASE_URL: '${{ secrets.OPENAI_BASE_URL }}'",
      );
      expect(step).toContain('start_openai_proxy');
      expect(step).toContain('node .github/scripts/openai-proxy.mjs');
      expect(step).toContain('OPENAI_API_KEY=qwen-loopback-proxy');
      expect(step).toContain(
        'NO_PROXY="127.0.0.1,localhost,::1${NO_PROXY:+,${NO_PROXY}}"',
      );
      expect(step).toContain('no_proxy="${NO_PROXY}"');
      expect(step).toContain('unset QWEN_UPSTREAM_OPENAI_API_KEY');
      expect(step).toContain('unset QWEN_UPSTREAM_OPENAI_BASE_URL');
    }
    expect(openAiProxyLaunches).toHaveLength(3);
    expect(workflow).not.toContain('proxy_script="$(mktemp');
    expect(workflow).not.toContain('cat > "${proxy_script}"');
  });

  it('keeps the OpenAI proxy behavior covered by a runnable script', async () => {
    expect(openAiProxyScript).toContain(
      "headers.set('authorization', `Bearer ${apiKey}`)",
    );
    expect(openAiProxyScript).toContain(
      "finishWith(res, 403, 'proxy: only POST /chat/completions is allowed\\n')",
    );

    const requests = [];
    const upstream = http.createServer((req, res) => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const tempDir = mkdtempSync(join(tmpdir(), 'qwen-openai-proxy-'));
    const infoPath = join(tempDir, 'proxy-info');
    const child = spawn('node', ['.github/scripts/openai-proxy.mjs'], {
      env: {
        ...process.env,
        QWEN_UPSTREAM_OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
        QWEN_UPSTREAM_OPENAI_API_KEY: 'real-key',
        QWEN_OPENAI_PROXY_INFO: infoPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    try {
      const proxyBase = await waitForProxy(infoPath, child);

      const health = await fetch(proxyBase.replace(/\/v1$/, '') + '/__health');
      expect(health.status).toBe(204);

      const denied = await fetch(`${proxyBase}/chat/completions`);
      expect(denied.status).toBe(403);

      const proxied = await fetch(`${proxyBase}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer fake-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messages: [] }),
      });
      expect(proxied.status).toBe(200);
      expect(await proxied.json()).toEqual({ ok: true });
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/v1/chat/completions',
          authorization: 'Bearer real-key',
        },
      ]);
    } finally {
      child.kill();
      upstream.close();
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
