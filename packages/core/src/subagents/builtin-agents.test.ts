/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import {
  BuiltinAgentRegistry,
  DEFAULT_BUILTIN_SUBAGENT_TYPE,
  REVIEW_BUILTIN_SUBAGENT_TYPE,
} from './builtin-agents.js';

const mockIsBashSearchAvailable = vi.hoisted(() => vi.fn(() => false));
vi.mock('../utils/bash-search-tools.js', () => ({
  isBashSearchAvailable: mockIsBashSearchAvailable,
}));

describe('BuiltinAgentRegistry', () => {
  describe('getBuiltinAgents', () => {
    it('should return array of builtin agents with correct properties', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();

      expect(agents).toBeInstanceOf(Array);
      expect(agents.length).toBeGreaterThan(0);

      agents.forEach((agent) => {
        expect(agent).toMatchObject({
          name: expect.any(String),
          description: expect.any(String),
          systemPrompt: expect.any(String),
          level: 'builtin',
          filePath: `<builtin:${agent.name}>`,
          isBuiltin: true,
        });
      });
    });

    it('should include general-purpose agent', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();
      const generalAgent = agents.find(
        (agent) => agent.name === 'general-purpose',
      );

      expect(generalAgent).toBeDefined();
      expect(generalAgent?.description).toContain('General-purpose agent');
      expect(generalAgent?.systemPrompt).toContain(
        'general-purpose subagent working for a parent agent',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Preserve unrelated user changes',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Verify factual claims before reporting',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'run the smallest relevant checks',
      );
      expect(generalAgent?.systemPrompt).toContain(
        'Report uncertainty or blockers',
      );
    });

    it('should let the Explore agent inherit the main model', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent).toBeDefined();
      expect(exploreAgent?.model).toBeUndefined();
    });

    it('keeps the Explore agent read-only without banning shell pipelines', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent?.tools).not.toContain(ToolNames.TODO_WRITE);
      expect(exploreAgent?.tools).not.toContain(ToolNames.MEMORY);
      expect(exploreAgent?.tools).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(exploreAgent?.systemPrompt).toContain(
        'pipelines are allowed when every command is read-only',
      );
      expect(exploreAgent?.systemPrompt).not.toContain('(>, >>, |)');
      expect(exploreAgent?.tools).toContain(ToolNames.SHELL);
      expect(exploreAgent?.tools).toContain(ToolNames.GREP);
      expect(exploreAgent?.tools).toContain(ToolNames.GLOB);
    });

    it('uses Shell search when Bash search is available', async () => {
      mockIsBashSearchAvailable.mockReturnValue(true);
      vi.resetModules();
      const { BuiltinAgentRegistry: BashBuiltinAgentRegistry } = await import(
        './builtin-agents.js'
      );

      const exploreAgent = BashBuiltinAgentRegistry.getBuiltinAgent('Explore');
      const reviewAgent =
        BashBuiltinAgentRegistry.getBuiltinAgent('review-agent');

      expect(exploreAgent?.tools).toContain(ToolNames.SHELL);
      expect(exploreAgent?.tools).not.toContain(ToolNames.GREP);
      expect(exploreAgent?.tools).not.toContain(ToolNames.GLOB);
      expect(exploreAgent?.systemPrompt).toContain('`rg --files`');
      expect(reviewAgent?.tools).toContain(ToolNames.SHELL);
      expect(reviewAgent?.tools).not.toContain(ToolNames.GREP);
      expect(reviewAgent?.tools).not.toContain(ToolNames.GLOB);
    });

    // Regression for #7126: Explore is a read-only search worker that
    // typically runs as a subagent with no human in the loop. An
    // interactive question tool would block the pipeline forever.
    it('should not give the Explore agent the interactive question tool', () => {
      const exploreAgent = BuiltinAgentRegistry.getBuiltinAgent('Explore');

      expect(exploreAgent?.tools).toBeDefined();
      expect(exploreAgent?.tools).not.toContain('ask_user_question');
    });

    it('reports a missing status-line input to the parent without asking the user', () => {
      const statuslineAgent =
        BuiltinAgentRegistry.getBuiltinAgent('statusline-setup');

      expect(statuslineAgent?.tools).not.toContain(ToolNames.ASK_USER_QUESTION);
      expect(statuslineAgent?.systemPrompt).toContain(
        'report that blocker to the parent agent',
      );
      expect(statuslineAgent?.systemPrompt).toContain(
        'stop without modifying settings',
      );
    });
  });

  describe('getBuiltinAgent', () => {
    it('should return correct agent for valid name', () => {
      const agent = BuiltinAgentRegistry.getBuiltinAgent('general-purpose');

      expect(agent).toMatchObject({
        name: 'general-purpose',
        level: 'builtin',
        filePath: '<builtin:general-purpose>',
        isBuiltin: true,
      });
    });

    it('should return null for invalid name', () => {
      expect(BuiltinAgentRegistry.getBuiltinAgent('invalid')).toBeNull();
      expect(BuiltinAgentRegistry.getBuiltinAgent('')).toBeNull();
    });
  });

  describe('isBuiltinAgent', () => {
    it('should return true for valid builtin agent names', () => {
      expect(BuiltinAgentRegistry.isBuiltinAgent('general-purpose')).toBe(true);
    });

    it('should return false for invalid names', () => {
      expect(BuiltinAgentRegistry.isBuiltinAgent('invalid')).toBe(false);
      expect(BuiltinAgentRegistry.isBuiltinAgent('')).toBe(false);
    });
  });

  describe('getBuiltinAgentNames', () => {
    it('should return array of agent names', () => {
      const names = BuiltinAgentRegistry.getBuiltinAgentNames();

      expect(names).toBeInstanceOf(Array);
      expect(names).toContain('general-purpose');
      expect(names.every((name) => typeof name === 'string')).toBe(true);
    });
  });

  describe('consistency', () => {
    it('should maintain consistency across all methods', () => {
      const agents = BuiltinAgentRegistry.getBuiltinAgents();
      const names = BuiltinAgentRegistry.getBuiltinAgentNames();

      // Names should match agents
      expect(names).toEqual(agents.map((agent) => agent.name));

      // Each name should be valid
      names.forEach((name) => {
        expect(BuiltinAgentRegistry.isBuiltinAgent(name)).toBe(true);
        expect(BuiltinAgentRegistry.getBuiltinAgent(name)).toBeDefined();
      });
    });
  });

  describe('review-agent', () => {
    // The whole point of this agent type is the `tools` field. A type that
    // declares none takes AgentCore.prepareTools' inherit-everything branch
    // and is handed every deferred schema on every turn — measured at 21,178
    // prompt tokens per turn against this list's 3,447 (DESIGN.md — The
    // inherited tool surface). So these assertions are about the token bill,
    // not about tidiness.
    it('declares an explicit tool list', () => {
      const agent = BuiltinAgentRegistry.getBuiltinAgent(
        REVIEW_BUILTIN_SUBAGENT_TYPE,
      );

      // `getBuiltinAgent` returns `null` on a miss, and vitest's
      // `toBeDefined()` accepts `null` — so this must be `not.toBeNull()` or a
      // renamed/removed entry sails through.
      expect(agent).not.toBeNull();
      // A SET plus a length, not an ordered array: declaration order carries
      // no semantics — `getFunctionDeclarationsFiltered` maps names to schemas
      // in whatever order it is handed — so alphabetising the list, or
      // grouping reads before writes, would turn the suite red while changing
      // nothing. Every tooth survives: adding `tool_search`, dropping `edit`,
      // or declaring `['*']` still fails.
      expect(new Set(agent!.tools)).toEqual(
        new Set([
          ToolNames.READ_FILE,
          ToolNames.GREP,
          ToolNames.GLOB,
          ToolNames.SHELL,
          ToolNames.WRITE_FILE,
          ToolNames.EDIT,
        ]),
      );
      expect(agent!.tools).toHaveLength(6);
    });

    it('pins the contract lines of its system prompt', () => {
      // Without these the prompt is unpinned: a probe blanking it to '' left
      // every other test in this change green, while every dimension agent
      // would have launched with no instructions at all — the same silent
      // failure the `tools` assertions above exist to prevent.
      const agent = BuiltinAgentRegistry.getBuiltinAgent(
        REVIEW_BUILTIN_SUBAGENT_TYPE,
      );
      expect(agent).not.toBeNull();
      const prompt = agent!.systemPrompt;

      expect(prompt).toContain('one part of a code review');
      // The assignment outranks everything else, including this prompt.
      expect(prompt).toContain('read that file first');
      expect(prompt).toContain('the entirety of your instructions');
      // …and the assignment is not always a FILE. Agent 8 is built with no
      // brief on disk — SKILL.md appends its domain brief inline — so a
      // prompt asserting "your assignment is a file" would send that
      // specialist after one that does not exist, from `systemInstruction`,
      // which outranks the launch prompt carrying the real assignment.
      expect(prompt).toContain('When the launch prompt names no brief');
      // The shared-tree restraint `general-purpose` used to carry.
      expect(prompt).toContain('Preserve unrelated changes in the tree');
      // The output contract the orchestrator's aggregation depends on.
      expect(prompt).toContain(
        'Report in the format your assignment specifies',
      );
      // A question would block forever — these run with no human in the loop.
      expect(prompt).toContain('never ask a question');

      // The cwd rule is SCOPED. A blanket "never `cd`" closes the Step 4
      // verifier's only route to its scratch tree: that tree is a SIBLING of
      // the review worktree (`<worktree>-scratch-<label>`), so
      // `run_shell_command(directory:)` fails the workspace check and `cd` is
      // the remaining way in. SKILL.md forbids only `cd` INTO the pinned
      // working directory, and this must not be broader than that.
      expect(prompt).not.toContain('Never `cd`');
      expect(prompt).toContain('that is where `cd` belongs');

      // Role-NEUTRAL: this prompt is `systemInstruction` for every role the
      // review launches, including one that reads no diff (Agent 7) and two
      // that rule on a findings file. A frame bounding scope to "your diff
      // ranges", or a blanket confidence bar, would override their briefs
      // from above — see the comment on the entry itself.
      expect(prompt).not.toContain('diff ranges');
      expect(prompt).not.toContain('Silence is better than noise');
    });

    it('omits the tools that would re-open the inherited surface', () => {
      const agent = BuiltinAgentRegistry.getBuiltinAgent(
        REVIEW_BUILTIN_SUBAGENT_TYPE,
      );
      // Without this a missing entry collapses to `[]`, which satisfies every
      // `not.toContain` below trivially.
      expect(agent).not.toBeNull();
      const tools = agent!.tools ?? [];

      // TOOL_SEARCH lets an agent reveal deferred tools at runtime, which
      // defeats a closed list — and at 357 tokens/turn it costs more than
      // two of the tools kept. (It does not leak into the parent: every
      // launch is given its own rebuilt registry.)
      expect(tools).not.toContain(ToolNames.TOOL_SEARCH);
      // SKILL is not merely unused: its presence injects the startup skills
      // catalogue into the agent's first user turn, which measured 3,623
      // tokens against 504 without it.
      expect(tools).not.toContain(ToolNames.SKILL);
      // AGENT would otherwise be granted — `prepareTools` special-cases it and
      // nesting is allowed by default — so this is a deliberate capability
      // removal: review parts are leaf workers whose findings must return
      // inline for the orchestrator to aggregate.
      expect(tools).not.toContain(ToolNames.AGENT);
    });

    it('leaves general-purpose as the only builtin that inherits every tool', () => {
      // general-purpose inherits everything by design; every other builtin
      // must declare a real list. `prepareTools` takes the inherit branch on
      // `hasWildcard || (no strings && no inline decls)`, so a declared
      // `['*']` is the same surface as declaring nothing — both are caught.
      const inheriting = BuiltinAgentRegistry.getBuiltinAgents()
        .filter(
          (agent) =>
            !agent.tools ||
            agent.tools.length === 0 ||
            agent.tools.includes('*'),
        )
        .map((agent) => agent.name);

      expect(inheriting).toEqual([DEFAULT_BUILTIN_SUBAGENT_TYPE]);
    });
  });
});
