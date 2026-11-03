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
    for (const trigger of [triggers.pull_request, triggers.push]) {
      expect(trigger.paths).toEqual(
        expect.arrayContaining([
          'packages/web-shell/client/**',
          'packages/web-shell/package.json',
          'packages/web-shell/vite.lib.config.ts',
          '.github/workflows/web-shell-managed-host.yml',
        ]),
      );
    }
  });

  it('builds untrusted PR code with a read-only token and no secrets', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflowSource).not.toContain('pull_request_target');
    // Match an actual expression, not the prose in the security comment.
    expect(workflowSource).not.toMatch(/\$\{\{\s*secrets\./);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.if).toContain("github.repository == 'QwenLM/qwen-code'");
    const checkout = job.steps.find((step) =>
      String(step.uses ?? '').startsWith('actions/checkout@'),
    );
    expect(checkout.with['persist-credentials']).toBe(false);
  });

  it('bounds the job and never cancels a post-merge witness', () => {
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(workflow.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('builds the managed-host mode and skips the monorepo prepare build', () => {
    expect(stepNamed('Build the managed host entry').run).toBe(
      'npm run build:managed-host --workspace=@qwen-code/web-shell',
    );
    expect(pkg.scripts['build:managed-host']).toBe(
      'vite build --config vite.lib.config.ts --mode managed-host',
    );
    // The entry externalizes nothing, so it needs no sibling workspace dist/.
    expect(stepNamed('Install dependencies').env.QWEN_SKIP_PREPARE).toBe('1');
  });

  it('builds every workspace dist the entry imports', () => {
    // The client imports `@qwen-code/sdk/daemon`, whose `exports` points into
    // that package's `dist/`; building only core left the lane red.
    expect(stepNamed('Build the SDK for the managed host entry').run).toBe(
      'corepack pnpm --filter @qwen-code/sdk build',
    );
  });

  it('asserts an emitted bundle rather than trusting a green exit code', () => {
    const verify = stepNamed('Verify the host entry emitted a usable bundle');
    expect(verify.run).toContain('dist-managed-host/index.js');
    expect(verify.run).toContain('test -s');
    expect(verify.run).toContain('renderManagedAgentWebShell');
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
