import { describe, expect, it } from 'vitest';
import type { DaemonWorkspaceAgentSummary } from '@qwen-code/webui/daemon-react-sdk';
import {
  canModifyAgent,
  filterAgents,
  isOverridden,
  preserveAgentSelection,
} from './agents-manager-logic';

const agents: DaemonWorkspaceAgentSummary[] = [
  {
    kind: 'agent',
    name: 'code-reviewer',
    description: 'Reviews code',
    level: 'project',
    isBuiltin: false,
    hasTools: true,
  },
  {
    kind: 'agent',
    name: 'code-reviewer',
    description: 'User-level reviewer',
    level: 'user',
    isBuiltin: false,
    hasTools: false,
  },
  {
    kind: 'agent',
    name: 'Explore',
    description: 'Fast explorer',
    level: 'builtin',
    isBuiltin: true,
    hasTools: true,
  },
  {
    kind: 'agent',
    name: 'ext-helper',
    description: 'Extension agent',
    level: 'extension',
    isBuiltin: false,
    hasTools: false,
    extensionName: 'my-ext',
  },
];

describe('agents manager logic', () => {
  it('filters agents by name query (case-insensitive)', () => {
    expect(filterAgents(agents, 'CODE')).toEqual([agents[0], agents[1]]);
    expect(filterAgents(agents, 'explore')).toEqual([agents[2]]);
    expect(filterAgents(agents, 'nonexistent')).toEqual([]);
  });

  it('filters agents by level', () => {
    expect(filterAgents(agents, '', 'project')).toEqual([agents[0]]);
    expect(filterAgents(agents, '', 'builtin')).toEqual([agents[2]]);
    expect(filterAgents(agents, 'code', 'user')).toEqual([agents[1]]);
  });

  it('combines query and level filter', () => {
    expect(filterAgents(agents, 'code', 'project')).toEqual([agents[0]]);
    expect(filterAgents(agents, 'code', 'builtin')).toEqual([]);
  });

  it('preserves only a selection that still exists', () => {
    expect(
      preserveAgentSelection({ name: 'Explore', level: 'builtin' }, agents),
    ).toBe(agents[2]);
    expect(
      preserveAgentSelection({ name: 'removed', level: 'project' }, agents),
    ).toBeNull();
    expect(preserveAgentSelection(null, agents)).toBeNull();
  });

  it('preserves the selected level when names are shadowed', () => {
    expect(
      preserveAgentSelection({ name: 'code-reviewer', level: 'user' }, agents),
    ).toBe(agents[1]);
  });

  it('detects overridden user-level agents', () => {
    expect(isOverridden(agents[1], agents)).toBe(true);
    expect(isOverridden(agents[0], agents)).toBe(false);
    expect(isOverridden(agents[2], agents)).toBe(false);
  });

  it('identifies modifiable agents', () => {
    expect(canModifyAgent(agents[0])).toBe(true);
    expect(canModifyAgent(agents[1])).toBe(true);
    expect(canModifyAgent(agents[2])).toBe(false);
    expect(canModifyAgent(agents[3])).toBe(false);
  });
});
