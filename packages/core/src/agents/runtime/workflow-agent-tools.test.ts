/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalAgentToolName,
  describeAgentToolAllowEntryProblem,
  listAgentToolNames,
  narrowAgentTools,
} from './workflow-agent-tools.js';

describe('canonicalAgentToolName', () => {
  it('maps a built-in display name to its tool name and keeps any other name', () => {
    expect(canonicalAgentToolName('Shell')).toBe('run_shell_command');
    expect(canonicalAgentToolName('read_file')).toBe('read_file');
    expect(canonicalAgentToolName('mcp__warehouse__query')).toBe(
      'mcp__warehouse__query',
    );
    expect(canonicalAgentToolName('Bash')).toBe('Bash');
  });
});

describe('describeAgentToolAllowEntryProblem', () => {
  // The declaration filter looks allowlist entries up by exact name, so every
  // pattern would name nothing an agent could be given.
  it.each([
    ['the everything wildcard', '*'],
    ['an MCP server wildcard', 'mcp__warehouse__*'],
    ['a tool-name prefix wildcard', 'mcp__warehouse__read_*'],
  ])('refuses %s as a pattern', (_label, name) => {
    expect(describeAgentToolAllowEntryProblem(name)).toMatch(
      /is a pattern, and the allowlist takes exact tool names/,
    );
  });

  it('refuses a whole MCP server', () => {
    expect(describeAgentToolAllowEntryProblem('mcp__warehouse')).toMatch(
      /names a whole MCP server/,
    );
  });

  // In code mode exec is how the agent calls every other tool.
  it.each([['exec'], ['Exec']])('refuses %s by either spelling', (name) => {
    expect(describeAgentToolAllowEntryProblem(name)).toMatch(
      /is the code-mode surface, not a tool to allow/,
    );
  });

  it.each([
    ['run_shell_command'],
    ['ReadFile'],
    ['mcp__warehouse__query'],
    ['Bash'],
  ])('accepts %s as a name (whether it exists is judged elsewhere)', (name) => {
    expect(describeAgentToolAllowEntryProblem(name)).toBeNull();
  });
});

describe('listAgentToolNames', () => {
  it('quotes names and caps a long list', () => {
    expect(listAgentToolNames(['a', 'b'])).toBe('"a", "b"');
    const many = Array.from({ length: 13 }, (_, i) => `t${i}`);
    const listed = listAgentToolNames(many);
    expect(listed).toContain('"t9"');
    expect(listed).not.toContain('"t10"');
    expect(listed).toMatch(/ and 3 more$/);
  });
});

describe('narrowAgentTools', () => {
  const floor = ['agent', 'ask_user_question', 'send_message'];

  it('keeps the requested tools when the agent type inherits every tool', () => {
    expect(
      narrowAgentTools({
        requested: ['Shell', 'read_file'],
        requestedNames: ['run_shell_command', 'read_file'],
        denies: floor,
        schema: false,
      }),
    ).toEqual(['run_shell_command', 'read_file']);
  });

  // Denies are applied after the allowlist, so naming a floor tool never
  // brings it back.
  it('removes floor and deny entries, MCP patterns included', () => {
    expect(
      narrowAgentTools({
        requested: [
          'agent',
          'read_file',
          'mcp__github__create_issue',
          'mcp__warehouse__query',
        ],
        requestedNames: [
          'agent',
          'read_file',
          'mcp__github__create_issue',
          'mcp__warehouse__query',
        ],
        denies: [...floor, 'mcp__github'],
        schema: false,
      }),
    ).toEqual(['read_file', 'mcp__warehouse__query']);
  });

  it('bounds the list by the agent type allowlist', () => {
    expect(
      narrowAgentTools({
        requested: ['Shell', 'ReadFile'],
        requestedNames: ['run_shell_command', 'read_file'],
        agentTypeTools: ['ReadFile', 'grep_search'],
        agentTypeToolNames: ['read_file', 'grep_search'],
        denies: floor,
        schema: false,
      }),
    ).toEqual(['read_file']);
  });

  // The agent type's own list is compared by exact resolved name, the same
  // way its declaration filter reads it: a pattern there admits nothing.
  it('gives an agent type pattern no power to admit a requested tool', () => {
    expect(() =>
      narrowAgentTools({
        requested: ['mcp__github__create_issue'],
        requestedNames: ['mcp__github__create_issue'],
        agentTypeTools: ['mcp__github__*'],
        agentTypeToolNames: ['mcp__github__*'],
        denies: floor,
        schema: false,
      }),
    ).toThrow(/none of "mcp__github__create_issue" is among the tools/);
  });

  it('names both lists as written when they share no tool', () => {
    expect(() =>
      narrowAgentTools({
        requested: ['Shell'],
        requestedNames: ['run_shell_command'],
        agentTypeTools: ['ReadFile'],
        agentTypeToolNames: ['read_file'],
        denies: floor,
        schema: false,
      }),
    ).toThrow(
      'agent({tools, agentType}): none of "Shell" is among the tools the agent type allows ("ReadFile").',
    );
  });

  it('refuses a list whose every tool is denied, naming the entries as written', () => {
    expect(() =>
      narrowAgentTools({
        requested: ['Shell', 'agent'],
        requestedNames: ['run_shell_command', 'agent'],
        denies: [...floor, 'run_shell_command'],
        schema: false,
      }),
    ).toThrow(/every tool in "Shell", "agent" is denied for this agent/);
  });

  it('adds structured_output once for a schema agent', () => {
    expect(
      narrowAgentTools({
        requested: ['read_file'],
        requestedNames: ['read_file'],
        agentTypeTools: ['read_file'],
        agentTypeToolNames: ['read_file'],
        denies: floor,
        schema: true,
      }),
    ).toEqual(['read_file', 'structured_output']);
    expect(
      narrowAgentTools({
        requested: ['structured_output', 'read_file'],
        requestedNames: ['structured_output', 'read_file'],
        denies: floor,
        schema: true,
      }),
    ).toEqual(['structured_output', 'read_file']);
  });

  it('collapses two spellings that resolve to one tool', () => {
    expect(
      narrowAgentTools({
        requested: ['query (warehouse MCP Server)', 'mcp__warehouse__query'],
        requestedNames: ['mcp__warehouse__query', 'mcp__warehouse__query'],
        denies: floor,
        schema: false,
      }),
    ).toEqual(['mcp__warehouse__query']);
  });
});
