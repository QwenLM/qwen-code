/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import { buildStatusLineInput } from '../../statusline/buildStatusLineInput.js';
import { StatusLineSetupAgent } from './statusline-setup-agent.js';

/**
 * A payload with every optional source populated. Used by the contract tests
 * below to check the agent's documented field list against reality.
 */
function buildMaximalInput() {
  return buildStatusLineInput({
    sessionId: 'sess-1',
    sessionName: 'Refactor the parser',
    cwd: '/work/.worktrees/feature',
    transcriptPath: '/tmp/sessions/sess-1.jsonl',
    permissionMode: 'acceptEdits',
    projectDir: '/work',
    addedDirs: ['/other'],
    modelId: 'ultimate',
    modelDisplayName: 'Ultimate',
    version: '1.2.3',
    totalLinesAdded: 1,
    totalLinesRemoved: 2,
    totalInputTokens: 100,
    totalOutputTokens: 20,
    contextWindowSize: 1000,
    usedPercentage: 10,
    remainingPercentage: 90,
    vimMode: 'INSERT',
    agentName: 'reviewer',
    worktree: {
      name: 'feature',
      path: '/work/.worktrees/feature',
      branch: 'feature',
      original_cwd: '/work',
      original_branch: 'main',
    },
  });
}

/**
 * Every key name quoted inside the prompt's stdin JSON example, at any depth.
 * The example carries `//` annotations, so it cannot simply be JSON.parsed.
 */
function documentedFieldNames(prompt: string): Set<string> {
  const start = prompt.indexOf('receive the following JSON input via stdin');
  const end = prompt.indexOf('You can use this JSON data in your command');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = prompt.slice(start, end);
  return new Set(
    [...block.matchAll(/"([a-z_]+)"\s*:/g)].map((match) => match[1]),
  );
}

/** Recursively collect every key name present in an emitted payload. */
function emittedFieldNames(
  value: unknown,
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) emittedFieldNames(child, into);
    return into;
  }
  if (!value || typeof value !== 'object') return into;
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    emittedFieldNames(child, into);
  }
  return into;
}

describe('StatusLineSetupAgent config paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the complete user config root in its instructions', async () => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CONFIG_DIR', '/tmp/full-root');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('EXAMPLE_CN_CONFIG_DIR', '/tmp/full-root');
    vi.resetModules();
    const { StatusLineSetupAgent } = await import(
      './statusline-setup-agent.js'
    );

    const definition = StatusLineSetupAgent({
      config: { getDefaultShellToolName: () => 'Bash' },
    } as unknown as AgentLoopContext);
    const prompt = definition.promptConfig.systemPrompt;

    expect(prompt).toContain(
      path.join('/tmp/full-root', 'statusline-command.sh'),
    );
    expect(prompt).toContain(path.join('/tmp/full-root', 'settings.json'));
    expect(prompt).not.toContain('~/abc');
  });
});

/**
 * The agent writes the user's statusline script straight from the field list in
 * its own system prompt. A field promised there but never emitted becomes a
 * `jq` null and a visibly missing segment in the user's status line, so the two
 * lists have to be checked against each other in both directions.
 */
describe('StatusLineSetupAgent shell capability', () => {
  it.each(['Bash', 'PowerShell'] as const)(
    'uses its own Config shell: %s',
    (shell) => {
      const definition = StatusLineSetupAgent({
        config: { getDefaultShellToolName: () => shell },
      } as unknown as AgentLoopContext);
      expect(definition.toolConfig?.tools).toContain(shell);
      expect(definition.toolConfig?.tools).not.toContain(
        shell === 'Bash' ? 'PowerShell' : 'Bash',
      );
    },
  );
});

describe('StatusLineSetupAgent field contract', () => {
  const prompt =
    StatusLineSetupAgent({
      config: { getDefaultShellToolName: () => 'Bash' },
    } as unknown as AgentLoopContext).promptConfig.systemPrompt ?? '';

  it('promises no field that buildStatusLineInput cannot emit', () => {
    const emitted = emittedFieldNames(buildMaximalInput());
    const undeliverable = [...documentedFieldNames(prompt)].filter(
      (name) => !emitted.has(name),
    );
    expect(undeliverable).toEqual([]);
  });

  it('documents every top-level field that is actually emitted', () => {
    const undocumented = Object.keys(buildMaximalInput()).filter(
      (name) => !documentedFieldNames(prompt).has(name),
    );
    expect(undocumented).toEqual([]);
  });

  it('marks the conditional fields as optional so scripts degrade gracefully', () => {
    for (const conditional of [
      'session_name',
      'added_dirs',
      'agent',
      'worktree',
    ]) {
      const line = prompt
        .split('\n')
        .find((candidate) => candidate.includes(`"${conditional}"`));
      expect(line, `no prompt line documents "${conditional}"`).toBeDefined();
      expect(line, `"${conditional}" is not marked Optional`).toMatch(
        /\/\/\s*Optional/,
      );
    }
  });
});
