/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_SUBAGENT_DISALLOWED_TOOLS } from '../../../agents/runtime/workflow-orchestrator.js';
import { ToolDisplayNames, ToolNames } from '../../../tools/tool-names.js';
import { parseSkillContent } from '../../skill-load.js';

const loadSkill = () => {
  const file = fileURLToPath(new URL('./SKILL.md', import.meta.url));
  return parseSkillContent(fs.readFileSync(file, 'utf8'), file);
};

describe('bundled workflow-authoring skill', () => {
  it('keeps authoring guidance from authorizing a run', () => {
    const skill = loadSkill();
    expect(skill.description).toContain('does not itself authorize');
    expect(skill.body.replace(/\s+/g, ' ')).toContain(
      'does not authorize a run',
    );
  });

  it.each([
    "interactive TUI's ink renderer",
    'OpenTUI renderer does not yet run client-scheduled tools',
    "Workflow({ name: '<name>' })",
  ])('states the script contract: %s', (anchor) => {
    expect(loadSkill().body.replace(/\s+/g, ' ')).toContain(anchor);
  });

  it('names exactly the tools a workflow subagent can never use', () => {
    const prose = loadSkill().body.replace(/\s+/g, ' ');
    const lead = 'Workflow subagents can never use ';
    const start = prose.indexOf(lead);
    const end = prose.indexOf(', whatever their `agentType`', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const named = prose.slice(start + lead.length, end).split(/,\s*(?:or\s+)?/);
    const displayNames = WORKFLOW_SUBAGENT_DISALLOWED_TOOLS.map((name) => {
      const key = Object.keys(ToolNames).find(
        (candidate) => ToolNames[candidate as keyof typeof ToolNames] === name,
      );
      return key
        ? (ToolDisplayNames as Record<string, string>)[key]
        : undefined;
    });
    expect(displayNames).not.toContain(undefined);
    expect(named).toHaveLength(displayNames.length);
    for (const displayName of displayNames) {
      expect(named.some((item) => item.includes(displayName!))).toBe(true);
    }
  });
});
