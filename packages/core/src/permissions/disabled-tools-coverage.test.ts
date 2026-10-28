/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeFakeConfig } from '../test-utils/config.js';
import type { Config } from '../config/config.js';
import { warnOnUnmatchedDisabledToolEntries } from './disabled-tools-coverage.js';

function makeConfig(opts: {
  disabled: string[];
  mcpServers?: Record<string, { command: string; args?: string[] }>;
}): Config {
  return makeFakeConfig({
    disabledTools: opts.disabled,
    trustedFolder: true,
    ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
  });
}

describe('tools.disabled entries that name no tool (#15752)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('names a misspelt entry and stays quiet about the ones that match', () => {
    const config = makeConfig({
      disabled: ['run_shell_command', 'run_shel_command'],
    });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('run_shel_command');
    expect(warnSpy.mock.calls[0]![0]).toContain('disables nothing');
  });

  it('says nothing when every entry names a known tool', () => {
    const config = makeConfig({
      disabled: ['run_shell_command', 'read_file'],
    });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts the display spelling the rules already understand', () => {
    const config = makeConfig({ disabled: ['Bash'] });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reports an entry once across repeated discovery passes', () => {
    const config = makeConfig({ disabled: ['run_shel_command'] });

    warnOnUnmatchedDisabledToolEntries(config);
    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('leaves a tool on a configured MCP server alone', () => {
    // A disabled MCP tool does not register either, so the registry cannot
    // confirm the name; a configured server is as close as this can get.
    const config = makeConfig({
      disabled: ['mcp__github__create_issue'],
      mcpServers: { github: { command: 'npx' } },
    });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still reports an entry whose MCP server is not configured at all', () => {
    const config = makeConfig({ disabled: ['mcp__githb__create_issue'] });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('mcp__githb__create_issue');
  });

  it('says nothing when nothing is disabled', () => {
    const config = makeConfig({ disabled: [] });

    warnOnUnmatchedDisabledToolEntries(config);

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
