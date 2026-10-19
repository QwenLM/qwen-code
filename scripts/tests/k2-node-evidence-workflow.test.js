/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

test('K2 software CI executes Linux tests without enabling native installation', () => {
  const workflow = parse(
    readFileSync('.github/workflows/k2-node-evidence.yml', 'utf8'),
  );
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(workflow.on.pull_request.paths).toContain(
    'packages/k2-node-evidence/**',
  );
  expect(workflow.on.pull_request.paths).toContain(
    'packages/managed-agent-server/src/test/resources/contracts/k2-*.json',
  );
  for (const event of ['pull_request', 'push']) {
    expect(workflow.on[event].paths).toContain('deploy/k2-evidence/**');
  }
  const artifacts = workflow.jobs['offline-artifacts'];
  expect(artifacts['runs-on']).toBe('ubuntu-latest');
  expect(artifacts['timeout-minutes']).toBe(10);
  expect(
    artifacts.steps.some(
      (step) =>
        step.uses === 'actions/setup-python@v5' &&
        step.with['python-version'] === '3.12',
    ),
  ).toBe(true);
  const artifactScripts = artifacts.steps
    .map((step) => step.run ?? '')
    .join('\n');
  expect(artifactScripts).toContain(
    "python3 -m unittest discover -s deploy/k2-evidence -p 'test_*.py' -v",
  );
  expect(artifactScripts).not.toMatch(
    /sudo|mount|apparmor_parser|k2-cold-init/,
  );
  const job = workflow.jobs.software;
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job.defaults.run['working-directory']).toBe(
    'packages/k2-node-evidence',
  );
  expect(
    job.steps.some(
      (step) =>
        step.uses === 'actions/setup-go@v6' &&
        step.with['go-version'] === '1.26.3',
    ),
  ).toBe(true);
  const scripts = job.steps.map((step) => step.run ?? '').join('\n');
  expect(scripts).toMatch(/go mod verify/);
  expect(scripts).toMatch(/go test -mod=readonly -count=1 \.\/\.\.\./);
  expect(scripts).toMatch(/for architecture in amd64 arm64/);
  expect(scripts).toMatch(
    /GOOS=linux GOARCH="\$architecture" CGO_ENABLED=0 go build/,
  );
  expect(scripts).not.toMatch(/sudo|mount|apparmor_parser|k2-cold-init/);
});
