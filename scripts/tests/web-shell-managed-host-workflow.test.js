/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The managed-host mount entry is unpublished: it is absent from the package
// `exports` and `files`, and no consumer in the repo imports it. Its only
// protection against rot is this lane. It previously rode `npm run build`,
// which charged every local build and every fresh-clone `prepare` for a full
// non-externalized bundle; moving it here is only a fix if BOTH halves hold —
// the lane really runs the mode, and the default build really stopped doing so.
// These assertions pin that split, because either half silently regressing
// leaves the entry unprotected or the tax back in place with every suite green.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflowSource = readFileSync(
  path.join(repoRoot, '.github/workflows/web-shell-managed-host.yml'),
  'utf8',
);
const workflow = parse(workflowSource);
// `on:` parses as the boolean true in YAML 1.1.
const triggers = workflow[true] ?? workflow['on'];
const job = workflow.jobs.build;
const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages/web-shell/package.json'), 'utf8'),
);
const stepNamed = (name) =>
  job.steps.find((candidate) => candidate.name === name);

describe('managed host build lane', () => {
  it('runs on pull requests, post-merge pushes and manual dispatch', () => {
    expect(Object.keys(triggers).sort()).toEqual([
      'pull_request',
      'push',
      'workflow_dispatch',
    ]);
    expect(triggers.push.branches).toEqual(['main']);
    expect(triggers.pull_request.branches).toContain('main');
  });

  it('triggers on the entry, its build wiring and itself', () => {
    // A path filter that misses the config or the entry would report "skipped"
    // on the very changes that can break the mode — agreement without a run.
    // The set is exact rather than `arrayContaining`: this lane builds core,
    // acp-bridge and the SDK from source and reads `WEB_SHELL_BUILD_TARGET`
    // from `vite.config.ts`, so a filter that omits any of them reports
    // "skipped" on the change that breaks it. An exact set also means an entry
    // cannot be dropped from the workflow with this suite still green.
    const expectedPaths = [
      '.github/workflows/web-shell-managed-host.yml',
      'packages/acp-bridge/package.json',
      'packages/acp-bridge/src/**',
      'packages/core/package.json',
      'packages/core/src/**',
      'packages/sdk-typescript/package.json',
      'packages/sdk-typescript/src/**',
      'packages/web-shell/client/**',
      'packages/web-shell/package.json',
      'packages/web-shell/pierre-build.ts',
      'packages/web-shell/vite.config.ts',
      'packages/web-shell/vite.lib.config.ts',
      'pnpm-lock.yaml',
    ];
    for (const trigger of [triggers.pull_request, triggers.push]) {
      expect(trigger.paths).toHaveLength(expectedPaths.length);
      expect([...trigger.paths].sort()).toEqual(expectedPaths);
    }
  });

  it('builds untrusted PR code with a read-only token and no secrets', () => {
    // A job-level `permissions:` block replaces the workflow default, so the
    // job's effective scope is the one the untrusted build actually runs with.
    expect(job.permissions ?? workflow.permissions).toEqual({
      contents: 'read',
    });
    expect(workflowSource).not.toContain('pull_request_target');
    // Match any expression that reads the context: `${{ toJSON(secrets) }}` is
    // as much a read as `secrets.TOKEN`. The conflict check below is the
    // control — the workflow's own `${{ github.* }}` expressions, which a guard
    // broadened to every expression would red on instead of passing silently.
    const secretRef = /\$\{\{[^}]*\bsecrets\b/;
    expect(workflowSource).not.toMatch(secretRef);
    expect(workflowSource).toMatch(/\$\{\{\s*github\./);
    expect(job['runs-on']).toBe(
      "${{ (github.event_name == 'pull_request' && vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true') && fromJSON('[\"self-hosted\", \"ecs-qwen-ephemeral\"]') || fromJSON('[\"ubuntu-latest\"]') }}",
    );
    expect(job.if).toContain("github.repository == 'QwenLM/qwen-code'");
    const checkout = job.steps.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout@'),
    );
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('bounds the job and never cancels a post-merge witness', () => {
    expect(job['timeout-minutes']).toBe(
      "${{ (github.event_name == 'pull_request' && vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true') && 90 || 20 }}",
    );
    expect(workflow.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('prepares the disposable pool without changing hosted setup', () => {
    const hostedNode = stepNamed('Set up Node.js 22.x');
    expect(hostedNode.if).toBe("${{ runner.environment == 'github-hosted' }}");
    const poolNode = stepNamed('Use pre-installed Node.js (self-hosted)');
    expect(poolNode.uses).toBe('./.github/actions/self-hosted-node');
    expect(poolNode.if).toBe("${{ runner.environment == 'self-hosted' }}");
    const diskFloor = stepNamed('Disk floor gate (self-hosted)');
    expect(diskFloor.if).toBe("${{ runner.environment == 'self-hosted' }}");
    expect(diskFloor.env).toEqual({
      DISK_FLOOR_MIN_FREE_KB: '8388608',
      DISK_FLOOR_MAX_USED_PCT: '85',
    });
  });

  it('builds the managed-host mode without the monorepo prepare build', () => {
    expect(stepNamed('Build the managed host entry').run).toBe(
      'npm run build:managed-host --workspace=@qwen-code/web-shell',
    );
    expect(pkg.scripts['build:managed-host']).toBe(
      'vite build --config vite.lib.config.ts --mode managed-host',
    );
    // `prepare` would rebuild every workspace; the three targeted steps below
    // build only the dists this entry actually resolves through.
    expect(stepNamed('Install dependencies').env.QWEN_SKIP_PREPARE).toBe('1');
  });

  it('builds every workspace dist the entry imports', () => {
    // The client imports `@qwen-code/sdk/daemon`, whose `exports` points into
    // that package's `dist/`, and the SDK in turn resolves core and acp-bridge
    // through their own `dist/`. All three are load-bearing: dropping any one
    // reds the lane on an unresolved import, so pin each rather than just the
    // last. `tsconfig.reference.json` references only ../core, so `tsc --build`
    // never produces acp-bridge — hence its own step and this fixed order.
    expect(stepNamed('Build core for the managed host entry').run).toBe(
      'corepack pnpm --filter @qwen-code/qwen-code-core build',
    );
    expect(stepNamed('Build acp-bridge for the SDK reference build').run).toBe(
      'corepack pnpm --filter @qwen-code/acp-bridge build',
    );
    expect(stepNamed('Build the SDK for the managed host entry').run).toBe(
      'corepack pnpm --filter @qwen-code/sdk build',
    );
    const buildOrder = job.steps
      .map((step) => step.name)
      .filter((name) => String(name).startsWith('Build '));
    expect(buildOrder).toEqual([
      'Build core for the managed host entry',
      'Build acp-bridge for the SDK reference build',
      'Build the SDK for the managed host entry',
      'Build the managed host entry',
    ]);
  });

  it('asserts an emitted bundle rather than trusting a green exit code', () => {
    const verify = stepNamed('Verify the host entry emitted a usable bundle');
    expect(verify.run).toContain('dist-managed-host/index.js');
    expect(verify.run).toContain('test -s');
    expect(verify.run).toContain('renderManagedAgentWebShell');
    // The CSS half must key on the injection preamble. A JSX prop name such as
    // `data-managed-empty` survives minification as an object key even when the
    // plugin's per-entry guard stops matching and no stylesheet is injected,
    // so grepping it would pass on an unstyled bundle.
    expect(verify.run).toContain('__qwenWebShellCss');
    expect(verify.run).toContain(
      'grep -qF \'data-qwen-web-shell-entry="managed-host"\'',
    );
    // The portal wrapper ships in its own chunk, and every occurrence in the
    // entry sits inside the injected stylesheet, so the check must search the
    // whole output for the quoted JSX prop a CSS scope cannot produce.
    expect(verify.run).toContain(
      `grep -rqF 'data-web-shell-portal-root":' 'packages/web-shell/dist-managed-host'`,
    );
    expect(verify.run).not.toContain("grep -q 'data-managed-empty'");
  });

  it('keeps the output outside the directory the app build empties', () => {
    const verify = stepNamed(
      'Verify the host output stays outside the app build directory',
    );
    expect(verify.run).toContain('packages/web-shell/dist/managed-host');
    const config = readFileSync(
      path.join(repoRoot, 'packages/web-shell/vite.lib.config.ts'),
      'utf8',
    );
    expect(config).toContain(
      "mode === 'managed-host' ? 'dist-managed-host' : 'dist'",
    );
  });
});

describe('managed host stays out of the default build and the package', () => {
  it('does not charge the default build for the host bundle', () => {
    expect(pkg.scripts.build).not.toContain('managed-host');
    // The default passes it replaces must survive the split.
    expect(pkg.scripts.build).toContain('--mode transcript');
    expect(pkg.scripts.build).toContain('tsc -p tsconfig.lib.json');
  });

  it('keeps the entry unpublished so the lane is its only gate', () => {
    const targets = Object.values(pkg.exports).flatMap((entry) =>
      typeof entry === 'string' ? [entry] : Object.values(entry),
    );
    expect(targets.some((target) => target.includes('managed-host'))).toBe(
      false,
    );
    expect(pkg.files).toContain('!dist/types/managed-host.d.ts');
  });
});
