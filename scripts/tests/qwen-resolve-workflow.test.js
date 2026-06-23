/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('qwen resolve workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/qwen-code-pr-review.yml'),
    'utf8',
  );

  it('uses the existing PR command workflow', () => {
    expect(
      existsSync(path.join(repoRoot, '.github/workflows/qwen-fix-conflicts.yml')),
    ).toBe(false);
    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain("github.event.inputs.command == 'resolve'");
    expect(workflow).toContain("startsWith(github.event.comment.body, '@qwen-code /resolve')");
    expect(workflow).toContain('needs.authorize.outputs.should_review');
    expect(workflow).not.toContain('authorize-resolve:');
    expect(workflow).toContain("github.event.comment.body == '@qwen-code /resolve'");
  });

  it('listens for /resolve comments', () => {
    expect(workflow).toContain(
      "github.event.comment.body == '@qwen-code /resolve'",
    );
    expect(workflow).toContain(
      "startsWith(github.event.comment.body, '@qwen-code /resolve ')",
    );
    expect(workflow).toContain("format('@qwen-code /resolve{0}',");
    expect(workflow).not.toContain('/fix_conflicts');
  });

  it('reports failure paths instead of falling through silently', () => {
    expect(workflow).toContain('if ! npm run build; then');
    expect(workflow).toContain('if ! npm run typecheck; then');
    expect(workflow).toContain('if ! npm run lint; then');
    expect(workflow).toContain("- name: 'Report result'");
    expect(workflow).toContain(
      'Qwen Code attempted to resolve merge conflicts but the run did not complete successfully.',
    );
    expect(workflow).toContain('push_failed=false');
    expect(workflow).toContain('push_failed=true');
    expect(workflow).toContain('Check the [workflow run]');
  });

  it('fails unknown conflict detection explicitly', () => {
    expect(workflow).toContain('if [ "$conflict" = "unknown" ]; then');
    expect(workflow).toContain('Could not determine conflict status');
  });

  it('refreshes dependencies after conflict resolution', () => {
    expect(workflow).toContain("- name: 'Refresh dependencies'");
    expect(workflow).toContain("steps.resolve_conflicts.outcome == 'success'");
  });

  it('uses resolve naming for run artifacts', () => {
    expect(workflow).toContain('qwen-resolve-');
    expect(workflow).toContain('/tmp/qwen-resolve');
    expect(workflow).toContain('<!-- qwen-resolve-result -->');
    expect(workflow).not.toContain('qwen-fix-conflicts');
  });
});
