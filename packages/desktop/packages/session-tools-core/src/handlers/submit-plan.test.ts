import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { handleSubmitPlan } from './submit-plan.ts';
import type { SessionToolContext } from '../context.ts';

function createCtx(
  plansFolderPath: string,
  opts: {
    exists?: boolean;
    readFile?: string;
    onRead?: (path: string) => void;
    onSubmitted?: (path: string) => void;
  } = {}
): SessionToolContext {
  return {
    sessionId: 'session-123',
    workspacePath: join('/tmp', 'workspace'),
    get sourcesPath() {
      return join(this.workspacePath, 'sources');
    },
    get skillsPath() {
      return join(this.workspacePath, 'skills');
    },
    plansFolderPath,
    callbacks: {
      onPlanSubmitted: (path: string) => opts.onSubmitted?.(path),
      onAuthRequest: () => {},
    },
    fs: {
      exists: () => opts.exists ?? true,
      readFile: (path: string) => {
        opts.onRead?.(path);
        return opts.readFile ?? '# Plan';
      },
      readFileBuffer: () => Buffer.from(opts.readFile ?? '# Plan'),
      writeFile: () => {},
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
  };
}

describe('handleSubmitPlan', () => {
  const plansFolderPath = join('/tmp', 'workspace', 'sessions', 'session-123', 'plans');

  it('submits a plan inside the session plans directory', async () => {
    const submitted: string[] = [];
    const planPath = join(plansFolderPath, 'plan.md');
    const ctx = createCtx(plansFolderPath, {
      onSubmitted: (path) => submitted.push(path),
    });

    const result = await handleSubmitPlan(ctx, { planPath });

    expect(result.isError).toBe(false);
    expect(submitted).toEqual([planPath]);
  });

  it('rejects sibling paths that share the plans directory prefix', async () => {
    const readAttempts: string[] = [];
    const submitted: string[] = [];
    const siblingPlanPath = join(`${plansFolderPath}-other`, 'plan.md');
    const ctx = createCtx(plansFolderPath, {
      onRead: (path) => readAttempts.push(path),
      onSubmitted: (path) => submitted.push(path),
    });

    const result = await handleSubmitPlan(ctx, { planPath: siblingPlanPath });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('session plans directory');
    expect(readAttempts).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it('rejects paths that escape the plans directory through a symlink', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const rootDir = mkdtempSync(join(tmpdir(), 'submit-plan-boundary-'));
    try {
      const realPlansDir = join(rootDir, 'plans');
      const outsideDir = join(rootDir, 'outside');
      mkdirSync(realPlansDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'plan.md'), '# outside');
      symlinkSync(outsideDir, join(realPlansDir, 'escape-link'), 'dir');

      const readAttempts: string[] = [];
      const submitted: string[] = [];
      const ctx = createCtx(realPlansDir, {
        onRead: (path) => readAttempts.push(path),
        onSubmitted: (path) => submitted.push(path),
      });

      const result = await handleSubmitPlan(ctx, {
        planPath: join(realPlansDir, 'escape-link', 'plan.md'),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('session plans directory');
      expect(readAttempts).toEqual([]);
      expect(submitted).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
