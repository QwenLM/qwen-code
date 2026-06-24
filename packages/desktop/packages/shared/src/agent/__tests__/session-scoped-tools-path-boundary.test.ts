import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  getSessionPlansDir,
  isPathInPlansDir,
} from '../session-scoped-tools.ts';

describe('session-scoped plan path helpers', () => {
  const workspacePath = join('/tmp', 'workspace');
  const sessionId = 'session-123';

  it('allows the plans directory itself', () => {
    const plansDir = getSessionPlansDir(workspacePath, sessionId);

    expect(isPathInPlansDir(plansDir, workspacePath, sessionId)).toBe(true);
  });

  it('allows child paths inside the plans directory', () => {
    const plansDir = getSessionPlansDir(workspacePath, sessionId);
    const planPath = join(plansDir, 'plan.md');

    expect(isPathInPlansDir(planPath, workspacePath, sessionId)).toBe(true);
  });

  it('rejects sibling paths that share the plans directory prefix', () => {
    const plansDir = getSessionPlansDir(workspacePath, sessionId);
    const siblingPlanPath = join(`${plansDir}-other`, 'plan.md');

    expect(isPathInPlansDir(siblingPlanPath, workspacePath, sessionId)).toBe(false);
  });
});
