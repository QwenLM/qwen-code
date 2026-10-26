/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILTIN_SUBAGENT_TYPE } from '@qwen-code/qwen-code-core/subagents/builtin-agents.js';
import { ROOT_AGENT_IDENTITY, deriveSubagentIdentity } from './types.js';

describe('deriveSubagentIdentity', () => {
  // Core resolves an omitted `subagent_type` to DEFAULT_BUILTIN_SUBAGENT_TYPE
  // and persists that canonical name, which replay rebuilds as
  // `/root/${subagentName}`. The live wire has to mint the same path, or one
  // run reads as two different agents before and after a reload.
  it.each(['', '   '])(
    'degrades an absent subagent_type %p to the name replay rebuilds',
    (requested) => {
      expect(deriveSubagentIdentity(requested)).toEqual({
        agentName: `/root/${DEFAULT_BUILTIN_SUBAGENT_TYPE}`,
        depth: 1,
        kind: 'subagent',
      });
      expect(deriveSubagentIdentity(requested).agentName).toBe(
        '/root/general-purpose',
      );
    },
  );

  it('passes a named type through verbatim', () => {
    expect(deriveSubagentIdentity('Explore')).toEqual({
      agentName: '/root/Explore',
      depth: 1,
      kind: 'subagent',
    });
  });

  it('nests under the spawning agent rather than the session root', () => {
    const parent = deriveSubagentIdentity('Explore');
    expect(deriveSubagentIdentity('code-reviewer', parent)).toEqual({
      agentName: '/root/Explore/code-reviewer',
      depth: 2,
      kind: 'subagent',
    });
    expect(ROOT_AGENT_IDENTITY).toEqual({
      agentName: '/root',
      depth: 0,
      kind: 'root',
    });
  });
});
