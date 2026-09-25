/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assembleRequests,
  AssemblyError,
  classifyResult,
  deliverResult,
  describeThinking,
  estimateTokens,
  freezeRequest,
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
    ).toThrow(/docs.zh.gone\.md/);
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

  it('sends the frozen realtime parameters and lets the plan override only what it sets', () => {
    const request = freezeRequest({
      samplingParams: { temperature: 0.3, max_tokens: 2048 },
      extra_body: { enable_thinking: true },
    });
    const bodyOf = (p: typeof plan, r = request) =>
      assembleRequests(p, [item()], 1, root, 'qwen-plus', r)[0].line[
        'body'
      ] as Record<string, unknown>;
    expect(bodyOf(plan)).toMatchObject({
      model: 'qwen-plus',
      temperature: 0.3,
      max_tokens: 2048,
      enable_thinking: true,
    });
    expect(
      bodyOf({ ...plan, maxOutputTokens: 8192, enableThinking: false }),
    ).toMatchObject({ max_tokens: 8192, enable_thinking: false });
    // Nothing configured: nothing injected, the provider default applies.
    expect(bodyOf(plan, freezeRequest(undefined))).not.toHaveProperty(
      'enable_thinking',
    );
  });
  it('enables tiered thinking when the frozen model settings disabled it', () => {
    const request = freezeRequest({ reasoning: false }, 'qwen3.8-max');
    const body = assembleRequests(
      { ...plan, enableThinking: true },
      [item()],
      1,
      root,
      'qwen3.8-max',
      request,
    )[0].line['body'];
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('enable_thinking');
    expect(request.params).toEqual({ reasoning_effort: 'none' });
  });
});

describe('freezeRequest', () => {
  it('disables thinking in the wire shape realtime uses for the model', () => {
    // Tiered Qwen reads reasoning_effort; other Qwen models the switch.
    expect(freezeRequest({ reasoning: false }, 'qwen3.8-max').params).toEqual({
      reasoning_effort: 'none',
    });
    expect(freezeRequest({ reasoning: false }, 'qwen-plus').params).toEqual({
      enable_thinking: false,
    });
    // Other families have their own knobs: send nothing and say so.
    const gpt = freezeRequest({ reasoning: false }, 'gpt-5.4');
    expect(gpt.params).toEqual({});
    expect(gpt.notes.join()).toMatch(/not reproduced for gpt-5.4/);
  });

  it('writes the output limit under the budget key the frozen params use', () => {
    const [request] = assembleRequests(
      { ...plan, maxOutputTokens: 4096 },
      [item()],
      1,
      root,
      'gpt-5.4',
      freezeRequest({ samplingParams: { max_completion_tokens: 1024 } }),
    );
    const body = request.line['body'] as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(4096);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('sends samplingParams and extra_body verbatim, as realtime does', () => {
    const { params } = freezeRequest({
      samplingParams: {
        temperature: 0.2,
        max_tokens: 1000,
        thinking_budget: 512,
        top_k: null,
      },
      extra_body: { temperature: 0.7, reasoning_effort: 'low' },
    });
    expect(params).toEqual({
      temperature: 0.7,
      max_tokens: 1000,
      thinking_budget: 512,
      reasoning_effort: 'low',
    });
  });

  it('removes a disabling effort from thinking-mandatory models', () => {
    const request = freezeRequest(
      {
        thinkingMandatory: true,
        extra_body: { reasoning_effort: 'none' },
      },
      'qwen3.8-max',
    );
    expect(request.params).not.toHaveProperty('reasoning_effort');
    expect(request.notes.join()).toMatch(/cannot be disabled/);
  });

  it('resolves the thinking switch with the realtime precedence', () => {
    // extra_body is merged last on the realtime wire, so it wins.
    expect(
      freezeRequest({
        samplingParams: { enable_thinking: false },
        extra_body: { enable_thinking: true },
      }).params['enable_thinking'],
    ).toBe(true);
    expect(
      freezeRequest({ extra_body: { enable_thinking: true } }).params[
        'enable_thinking'
      ],
    ).toBe(true);
    expect(
      freezeRequest({ reasoning: false }, 'qwen-plus').params[
        'enable_thinking'
      ],
    ).toBe(false);
  });

  it('lets a disabled reasoning beat a preset that enables thinking', () => {
    // The ModelStudio presets carry `extra_body.enable_thinking: true`, and
    // realtime applies `reasoning: false` only after merging extra_body — so
    // there the switch ends up off. Freezing the preset verbatim instead
    // bills thinking tokens the user turned off.
    const preset = {
      extra_body: { enable_thinking: true },
      reasoning: false as const,
    };
    expect(freezeRequest(preset, 'qwen-plus').params['enable_thinking']).toBe(
      false,
    );
    const tiered = freezeRequest(preset, 'qwen3.8-max').params;
    expect(tiered['reasoning_effort']).toBe('none');
    expect(tiered).not.toHaveProperty('enable_thinking');
  });

  it('never disables thinking on a thinking-mandatory model', () => {
    const frozen = freezeRequest({
      reasoning: false,
      thinkingMandatory: true,
    });
    expect(frozen.params).not.toHaveProperty('enable_thinking');
    expect(frozen.thinkingMandatory).toBe(true);
    expect(frozen.notes.join()).toMatch(/cannot be disabled/);
  });

  it('reports a reasoning effort it cannot reproduce instead of guessing', () => {
    const frozen = freezeRequest({ reasoning: { effort: 'high' } });
    expect(frozen.params).not.toHaveProperty('enable_thinking');
    expect(frozen.notes.join()).toMatch(/not reproduced/);
    expect(describeThinking(frozen)).toBe('thinking: provider default');
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
    expect(verdict).toEqual({ kind: 'ok', content: '# Intro\n' });
  });

  it('delivers the completion verbatim, including meaningful whitespace', () => {
    // An indented Markdown code block loses its indent under trim(), and the
    // trailing newline is part of the generated file.
    const doc = '# Intro\n\n    indented code line\n';
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: { status_code: 200, body: okBody(doc) },
    });
    expect(verdict).toEqual({ kind: 'ok', content: doc });
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
    if (verdict.kind === 'failed') {
      expect(verdict.reason).toMatch(/truncated/);
      expect(verdict.truncated).toBe(true);
    }
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

  it('accepts content with an odd number of ``` (truncation is finish_reason)', () => {
    const verdict = classifyResult({
      custom_id: 'a#1',
      response: {
        status_code: 200,
        body: okBody('Type ``` on its own line to open a fence.\n'),
      },
    });
    expect(verdict.kind).toBe('ok');
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
    expect(fs.readdirSync(path.join(root, 'docs', 'en'))).toEqual(['intro.md']);
  });

  it('holds instead of overwriting a target that appears while delivering', () => {
    const target = path.join(root, 'docs', 'en', 'intro.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'written meanwhile');
    const realExists = fs.existsSync;
    // The target shows up between the existence check and the write.
    const exists = vi
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => p !== target && realExists(p));
    try {
      const outcome = deliverResult(item(), content, root, sourceHash);
      expect(outcome.kind).toBe('held');
      expect(fs.readFileSync(target, 'utf8')).toBe('written meanwhile');
    } finally {
      exists.mockRestore();
    }
  });

  it('is idempotent: an identical existing target still counts as delivered', () => {
    deliverResult(item(), content, root, sourceHash);
    const outcome = deliverResult(item(), content, root, sourceHash);
    expect(outcome.kind).toBe('delivered');
  });

  it('removes its own partial write when the write fails after creating the file', () => {
    const target = path.join(root, 'docs', 'en', 'intro.md');
    const writeFileSync = fs.writeFileSync.bind(fs);
    // A write that fails after O_CREAT (disk full mid-write) leaves a
    // truncated file; delivered as-is it would wedge the target as a
    // phantom "different content" conflict on every later collect.
    const write = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((file, data, options) => {
        if (file === target) {
          writeFileSync(file, '# truncated');
          const error = new Error('ENOSPC: no space left on device, write');
          (error as NodeJS.ErrnoException).code = 'ENOSPC';
          throw error;
        }
        return writeFileSync(file, data, options);
      });
    try {
      expect(() => deliverResult(item(), content, root, sourceHash)).toThrow(
        /ENOSPC/,
      );
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      write.mockRestore();
    }
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

  it('holds a visible symlink into a hidden directory before creating children', () => {
    fs.mkdirSync(path.join(root, '.qwen'));
    fs.symlinkSync(
      path.join(root, '.qwen'),
      path.join(root, 'output'),
      'junction',
    );
    const outcome = deliverResult(
      item({ target: 'output/new/settings.json' }),
      content,
      root,
      sourceHash,
    );
    expect(outcome).toMatchObject({
      kind: 'held',
      reason: expect.stringContaining('hidden path'),
    });
    expect(fs.existsSync(path.join(root, '.qwen', 'new'))).toBe(false);
  });

  it('holds without creating directories outside a symlinked parent', () => {
    // `linked/new/` does not exist yet: containment must be proven at the
    // nearest existing ancestor before mkdir creates anything outside.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'));
      const outcome = deliverResult(
        item({ target: 'linked/new/out.md' }),
        content,
        root,
        sourceHash,
      );
      expect(outcome.kind).toBe('held');
      if (outcome.kind === 'held') expect(outcome.reason).toMatch(/outside/);
      expect(fs.existsSync(path.join(outside, 'new'))).toBe(false);
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

  it('counts CJK text at its own, denser rate', () => {
    expect(estimateTokens('a'.repeat(300))).toBe(75);
    expect(estimateTokens('中'.repeat(300))).toBe(200);
  });
});
