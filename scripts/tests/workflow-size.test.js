/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// GitHub does not start runs for a workflow file over 500 KB (512,000 bytes)
// and reports nothing when it stops — see .github/scripts/check-workflow-size.sh
// and .github/workflows/qwen-autofix.md for the incident this encodes.
const GITHUB_LIMIT_BYTES = 512_000;
const WORKFLOW_DIR = '.github/workflows';
const gateScript = readFileSync(
  '.github/scripts/check-workflow-size.sh',
  'utf8',
);
const ciWorkflow = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8');

const gateBytes = Number(
  gateScript.match(/GATE_BYTES="\$\{WORKFLOW_SIZE_GATE_BYTES:-(\d+)\}"/)?.[1],
);

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => join(WORKFLOW_DIR, name));

describe('workflow file size', () => {
  it('keeps the gate below GitHub 500 KB start-runs limit', () => {
    expect(gateBytes).toBeGreaterThan(0);
    expect(gateBytes).toBeLessThan(GITHUB_LIMIT_BYTES);
  });

  it.each(workflowFiles)('%s stays under the gate', (file) => {
    const bytes = Buffer.byteLength(readFileSync(file));
    expect(bytes).toBeLessThan(gateBytes);
  });

  it('runs the gate on every CI profile, not just full', () => {
    // A .github-only PR classifies as `github_ci_only`; gating the check on the
    // `full` profile would skip it for exactly the changes that can trip it.
    const step = ciWorkflow.match(
      /- name: 'Check workflow file size'[\s\S]*?run: '(.+?)'/,
    );
    expect(step?.[1]).toBe('.github/scripts/check-workflow-size.sh');
    expect(step?.[0]).toContain(
      'if: "${{ needs.classify_pr.outputs.skip_ci != \'true\' }}"',
    );
    expect(step?.[0]).not.toContain('ci_profile');
  });
});

describe('qwen-autofix.yml design-record pointers', () => {
  const workflow = readFileSync(join(WORKFLOW_DIR, 'qwen-autofix.yml'), 'utf8');
  const doc = readFileSync(join(WORKFLOW_DIR, 'qwen-autofix.md'), 'utf8');

  const pointers = [...workflow.matchAll(/qwen-autofix\.md#(af-\d+)/g)].map(
    (m) => m[1],
  );
  const anchors = [...doc.matchAll(/<a id="(af-\d+)"><\/a>/g)].map((m) => m[1]);

  it('every pointer resolves to a section', () => {
    expect(pointers.length).toBeGreaterThan(0);
    expect(
      [...new Set(pointers)].filter((id) => !anchors.includes(id)),
    ).toEqual([]);
  });

  it('every section is still pointed at from the workflow', () => {
    expect(anchors.filter((id) => !pointers.includes(id))).toEqual([]);
  });

  it('lists every section in the contents table', () => {
    const listed = [...doc.matchAll(/^- \[\d+\..*?\]\(#(af-\d+)\)$/gm)].map(
      (m) => m[1],
    );
    expect(listed).toEqual(anchors);
  });
});
