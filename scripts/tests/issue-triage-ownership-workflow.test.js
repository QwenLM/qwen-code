/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const workflowsDir = '.github/workflows';
const legacyWorkflows = [
  'check-issue-completeness.yml',
  'qwen-automated-issue-triage.yml',
  'qwen-scheduled-issue-triage.yml',
];

function triggersOnIssuesEvent(workflow, eventType) {
  const on = workflow?.on;
  if (on === 'issues') return true;
  if (Array.isArray(on) && on.includes('issues')) return true;
  if (on?.issues != null && !on.issues?.types) return true;
  return on?.issues?.types?.includes(eventType) ?? false;
}

function issueEventOwners(eventType) {
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => {
      const workflow = parse(readFileSync(`${workflowsDir}/${file}`, 'utf8'));
      return triggersOnIssuesEvent(workflow, eventType);
    });
}

describe('issue triage workflow ownership', () => {
  it('keeps one immediate owner for newly opened issues', () => {
    expect(issueEventOwners('opened')).toEqual(['qwen-triage.yml']);
  });

  it('keeps one immediate owner for reopened issues', () => {
    expect(issueEventOwners('reopened')).toEqual(['qwen-triage.yml']);
  });

  it('removes disabled legacy issue triage workflows', () => {
    for (const file of legacyWorkflows) {
      expect(existsSync(`${workflowsDir}/${file}`)).toBe(false);
    }
  });
});
