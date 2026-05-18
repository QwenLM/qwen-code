/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for each tool's `toAutoClassifierInput` projection. The projection
 * controls what the AUTO mode classifier sees about each tool call — it must
 * redact sensitive / voluminous fields (full edit content, web fetch prompts,
 * sub-agent prompts) while preserving enough for safety judgement.
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../config/config.js';

import { EditTool } from './edit.js';
import { WriteFileTool } from './write-file.js';
import { ShellTool } from './shell.js';
import { WebFetchTool } from './web-fetch.js';
import { SkillTool } from './skill.js';
import { AgentTool } from './agent/agent.js';

function minimalConfig(over: Partial<Record<string, unknown>> = {}): Config {
  return {
    getTargetDir: () => '/Users/test/project',
    getModelInvocableCommandsExecutor: () => undefined,
    ...over,
  } as unknown as Config;
}

// EditTool ────────────────────────────────────────────────────────────────

describe('EditTool.toAutoClassifierInput', () => {
  const tool = new EditTool(minimalConfig());

  it('truncates old_string and new_string to 80 chars and reports line delta', () => {
    const longOld = 'a'.repeat(200);
    const longNew = 'b'.repeat(200) + '\nextra line';
    const result = tool.toAutoClassifierInput({
      file_path: '/x/y.ts',
      old_string: longOld,
      new_string: longNew,
    } as never);
    expect(result).toEqual({
      file_path: '/x/y.ts',
      old_string_preview: 'a'.repeat(80),
      new_string_preview: 'b'.repeat(80),
      lines_changed: 1,
    });
  });

  it('reports zero lines_changed when no newlines are present', () => {
    const result = tool.toAutoClassifierInput({
      file_path: '/x/y.ts',
      old_string: 'foo',
      new_string: 'bar',
    } as never) as Record<string, unknown>;
    expect(result['lines_changed']).toBe(0);
  });
});

// WriteFileTool ──────────────────────────────────────────────────────────

describe('WriteFileTool.toAutoClassifierInput', () => {
  const tool = new WriteFileTool(minimalConfig());

  it('reports byte count and first 80 chars only', () => {
    const content = 'a'.repeat(500);
    const result = tool.toAutoClassifierInput({
      file_path: '/x/y.ts',
      content,
    } as never) as Record<string, unknown>;
    expect(result).toEqual({
      file_path: '/x/y.ts',
      byte_count: 500,
      first_80_chars: 'a'.repeat(80),
    });
  });

  it('handles multi-byte characters correctly in byte count', () => {
    const content = '你好世界';
    const result = tool.toAutoClassifierInput({
      file_path: '/x/y.ts',
      content,
    } as never) as Record<string, unknown>;
    expect(result['byte_count']).toBe(12); // 4 chars × 3 bytes (UTF-8)
  });
});

// ShellTool ──────────────────────────────────────────────────────────────

describe('ShellTool.toAutoClassifierInput', () => {
  const tool = new ShellTool(minimalConfig({ getTargetDir: () => '/cwd' }));

  it('forwards the full command — no redaction (needed for safety judgement)', () => {
    const result = tool.toAutoClassifierInput({
      command: 'rm -rf /tmp/build',
      is_background: false,
    } as never) as Record<string, unknown>;
    expect(result['command']).toBe('rm -rf /tmp/build');
  });

  it('falls back to config.getTargetDir() when directory is not provided', () => {
    const result = tool.toAutoClassifierInput({
      command: 'ls',
      is_background: false,
    } as never) as Record<string, unknown>;
    expect(result['cwd']).toBe('/cwd');
  });

  it('forwards directory when present', () => {
    const result = tool.toAutoClassifierInput({
      command: 'ls',
      is_background: false,
      directory: '/some/subdir',
    } as never) as Record<string, unknown>;
    expect(result['cwd']).toBe('/some/subdir');
  });
});

// WebFetchTool ────────────────────────────────────────────────────────────

describe('WebFetchTool.toAutoClassifierInput', () => {
  const tool = new WebFetchTool(minimalConfig());

  it('forwards only the URL — never the prompt', () => {
    const result = tool.toAutoClassifierInput({
      url: 'https://example.com/path',
      prompt: 'sensitive context about the user',
    } as never) as Record<string, unknown>;
    expect(result).toEqual({ url: 'https://example.com/path' });
    // Explicit check: prompt must not leak through.
    expect(JSON.stringify(result)).not.toContain('sensitive context');
  });
});

// SkillTool ──────────────────────────────────────────────────────────────
// SkillTool's constructor requires a fully-wired SkillManager via Config.
// Invoke the projection method via prototype to avoid that setup cost.

describe('SkillTool.toAutoClassifierInput', () => {
  it('forwards only the skill name', () => {
    const result = (
      SkillTool.prototype.toAutoClassifierInput as (
        p: unknown,
      ) => Record<string, unknown>
    ).call({}, { skill: 'my-skill' });
    expect(result).toEqual({ skill: 'my-skill' });
  });
});

// AgentTool ──────────────────────────────────────────────────────────────

describe('AgentTool.toAutoClassifierInput', () => {
  it('forwards full prompt and subagent_type (no truncation)', () => {
    // Regression guard: prior implementation truncated to 200 chars, which
    // hid attack payloads placed after character 200 from the classifier
    // while the sub-agent still received the full text. Same attack surface
    // as truncating a shell command.
    const longPrompt = 'task instruction '.repeat(50);
    const result = (
      AgentTool.prototype.toAutoClassifierInput as (
        p: unknown,
      ) => Record<string, unknown>
    ).call(
      {},
      {
        description: 'short desc',
        prompt: longPrompt,
        subagent_type: 'coder',
      },
    );
    expect(result['subagent_type']).toBe('coder');
    expect(result['prompt']).toBe(longPrompt);
    expect((result['prompt'] as string).length).toBe(longPrompt.length);
  });
});
