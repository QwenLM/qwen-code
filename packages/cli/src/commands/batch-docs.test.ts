/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assembleRequests,
  AssemblyError,
  classifyResult,
  deliverResult,
  estimateTokens,
  parseOutputJsonl,
  sha256,
} from './batch-docs.js';
import { validatePlan, type TaskItem } from './batch-task.js';

const plan = validatePlan(
  {
    version: 1,
    name: 'translate',
    kind: 'document-transform',
    shared: {
      system: 'You translate documents.',
      instructions: 'Translate to English. Return only the document.',
    },
    items: [
      { id: 'intro', source: 'docs/zh/intro.md', target: 'docs/en/intro.md' },
    ],
  },
  'plan.json',
);

const item = (overrides: Partial<TaskItem> = {}): TaskItem => ({
  id: 'intro',
  source: 'docs/zh/intro.md',
  target: 'docs/en/intro.md',
  state: 'submitted',
  ...overrides,
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-docs-'));
  fs.mkdirSync(path.join(root, 'docs', 'zh'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'zh', 'intro.md'),
    '# 介绍\n\n你好，世界。\n',
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('assembleRequests', () => {
  it('builds a self-contained request per item with the source embedded', () => {
    const [request] = assembleRequests(plan, [item()], 1, root, 'qwen-plus');
    expect(request.customId).toBe('intro#1');
    const body = request.line['body'] as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('qwen-plus');
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'You translate documents.',
    });
    expect(body.messages[1].content).toContain('Translate to English.');
    expect(body.messages[1].content).toContain('# 介绍\n\n你好，世界。');
    expect(body.messages[1].content).toContain(
      '<document path="docs/zh/intro.md">',
    );
    expect(request.sourceSha256).toBe(sha256('# 介绍\n\n你好，世界。\n'));
    expect(request.inputTokens).toBeGreaterThan(0);
  });

  it('refuses a source path that escapes the project root', () => {
    expect(() =>
      assembleRequests(
        plan,
        [item({ source: '../../etc/passwd' })],
        1,
        root,
        'qwen-plus',
      ),
    ).toThrow(AssemblyError);
  });

  it('refuses an absolute source path', () => {
    expect(() =>
      assembleRequests(
        plan,
        [item({ source: '/etc/passwd' })],
        1,
        root,
        'qwen-plus',
      ),
    ).toThrow(AssemblyError);
  });

  it('names the missing source when it cannot be read', () => {
    expect(() =>
      assembleRequests(
        plan,
        [item({ source: 'docs/zh/gone.md' })],
        1,
        root,
        'qwen-plus',
      ),
    ).toThrow(/docs\/zh\/gone\.md/);
  });

  it('refuses a source that symlinks out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not upload');
      fs.symlinkSync(
        path.join(outside, 'secret.txt'),
        path.join(root, 'docs', 'zh', 'secret.md'),
      );
      expect(() =>
        assembleRequests(
          plan,
          [item({ source: 'docs/zh/secret.md' })],
          1,
          root,
          'qwen-plus',
        ),
      ).toThrow(/resolves outside the project root/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('turns thinking off unless the plan opts in', () => {
    const bodyOf = (p: typeof plan) =>
      assembleRequests(p, [item()], 1, root, 'qwen-plus')[0].line['body'] as {
        enable_thinking?: boolean;
      };
    expect(bodyOf(plan).enable_thinking).toBe(false);
    expect(bodyOf({ ...plan, enableThinking: true }).enable_thinking).toBe(
      true,
    );
  });
});

describe('parseOutputJsonl', () => {
  it('parses lines and skips blanks', () => {
    const lines = parseOutputJsonl(
      '{"custom_id":"a#1"}\n\n{"custom_id":"b#1"}\n',
    );
    expect(lines).toHaveLength(2);
  });

  it('names the offending line on bad JSON', () => {
    expect(() => parseOutputJsonl('{"ok":1}\nnot json')).toThrow(/line 2/);
  });

  it('reports and skips a bad line when given a handler', () => {
    const bad: string[] = [];
    const lines = parseOutputJsonl('{"ok":1}\nnot json\n{"ok":2}', (m) =>
      bad.push(m),
    );
    expect(lines).toHaveLength(2);
    expect(bad).toEqual([expect.stringMatching(/line 2/)]);
  });
});

describe('classifyResult', () => {
  const okBody = (content: string, finish = 'stop') => ({
    choices: [
      { finish_reason: finish, message: { role: 'assistant', content } },
    ],
  });

  it('accepts a complete completion', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 200, body: okBody('# Intro\n') },
    });
    expect(verdict).toEqual({ kind: 'ok', content: '# Intro' });
  });

  it('rejects a non-200 request status', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 429, body: { error: 'slow down' } },
    });
    expect(verdict.kind).toBe('failed');
  });

  it('rejects provider-level errors', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      error: { message: 'boom' },
    });
    expect(verdict.kind).toBe('failed');
  });

  it('rejects truncated output (finish_reason=length)', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 200, body: okBody('# Intro', 'length') },
    });
    expect(verdict.kind).toBe('failed');
    if (verdict.kind === 'failed') expect(verdict.reason).toMatch(/truncated/);
  });

  it('rejects tool calls — this workflow executes none of them', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: {
        status_code: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '# Intro', tool_calls: [{ id: 'x' }] },
            },
          ],
        },
      },
    });
    expect(verdict.kind).toBe('failed');
    if (verdict.kind === 'failed') expect(verdict.reason).toMatch(/tool calls/);
  });

  it('accepts an empty tool_calls array', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: {
        status_code: 200,
        body: {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '# Intro', tool_calls: [] },
            },
          ],
        },
      },
    });
    expect(verdict).toEqual({ kind: 'ok', content: '# Intro' });
  });

  it('rejects empty content', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 200, body: okBody('   ') },
    });
    expect(verdict.kind).toBe('failed');
  });

  it('rejects unbalanced code fences as a truncation signal', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 200, body: okBody('text\n```ts\ncode\n') },
    });
    expect(verdict.kind).toBe('failed');
  });
});

describe('deliverResult', () => {
  const content = '# Intro\n\nHello, world.\n';
  const sourceHash = sha256('# 介绍\n\n你好，世界。\n');

  it('writes a new target and reports delivery', () => {
    const outcome = deliverResult(item(), content, root, sourceHash);
    expect(outcome.kind).toBe('delivered');
    expect(
      fs.readFileSync(path.join(root, 'docs', 'en', 'intro.md'), 'utf8'),
    ).toBe(content);
    // The staging file is gone; only the target remains.
    expect(fs.readdirSync(path.join(root, 'docs', 'en'))).toEqual(['intro.md']);
  });

  it('is idempotent: an identical existing target still counts as delivered', () => {
    deliverResult(item(), content, root, sourceHash);
    const outcome = deliverResult(item(), content, root, sourceHash);
    expect(outcome.kind).toBe('delivered');
  });

  it('holds when the target exists with different content', () => {
    fs.mkdirSync(path.join(root, 'docs', 'en'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'en', 'intro.md'), 'user edits');
    const outcome = deliverResult(item(), content, root, sourceHash);
    expect(outcome.kind).toBe('held');
    if (outcome.kind === 'held')
      expect(outcome.reason).toMatch(/already exists/);
    expect(
      fs.readFileSync(path.join(root, 'docs', 'en', 'intro.md'), 'utf8'),
    ).toBe('user edits');
  });

  it('holds when the source changed after submission', () => {
    const outcome = deliverResult(item(), content, root, sha256('different'));
    expect(outcome.kind).toBe('held');
    if (outcome.kind === 'held') expect(outcome.reason).toMatch(/changed/);
  });

  it('holds when the source vanished', () => {
    fs.rmSync(path.join(root, 'docs', 'zh', 'intro.md'));
    const outcome = deliverResult(item(), content, root, sourceHash);
    expect(outcome.kind).toBe('held');
    if (outcome.kind === 'held')
      expect(outcome.reason).toMatch(/no longer readable/);
  });

  it('refuses a target that escapes the project root', () => {
    const outcome = deliverResult(
      item({ target: '../outside.md' }),
      content,
      root,
      sourceHash,
    );
    expect(outcome.kind).toBe('held');
  });

  it('refuses a target whose directory symlinks out of the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'));
      const outcome = deliverResult(
        item({ target: 'linked/out.md' }),
        content,
        root,
        sourceHash,
      );
      expect(outcome.kind).toBe('held');
      if (outcome.kind === 'held') expect(outcome.reason).toMatch(/outside/);
      expect(fs.existsSync(path.join(outside, 'out.md'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('estimateTokens', () => {
  it('grows with input and never returns zero', () => {
    expect(estimateTokens('')).toBe(1);
    expect(estimateTokens('abcd')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('a'.repeat(300))).toBeGreaterThan(
      estimateTokens('a'.repeat(3)),
    );
  });
});
