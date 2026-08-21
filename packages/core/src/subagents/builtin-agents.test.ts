/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ToolNames } from '../tools/tool-names.js';
import {
  BuiltinAgentRegistry,
  DEFAULT_BUILTIN_SUBAGENT_TYPE,
  REVIEW_BUILTIN_SUBAGENT_TYPE,
} from './builtin-agents.js';

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

      expect(agent).toBeDefined();
      expect(agent?.tools).toEqual([
        ToolNames.READ_FILE,
        ToolNames.GREP,
        ToolNames.GLOB,
        ToolNames.SHELL,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT,
      ]);
    });

    it('pins the contract lines of its system prompt', () => {
      // Without these the prompt is unpinned: a probe blanking it to '' left
      // every other test in this change green, while every dimension agent
      // would have launched with no instructions at all — the same silent
      // failure the `tools` assertions above exist to prevent.
      const prompt =
        BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE)
          ?.systemPrompt ?? '';

      expect(prompt).toContain('one dimension of a code review');
      // The brief outranks the launch prompt, and the diff is read from a file.
      expect(prompt).toContain('Read the brief first');
      // Scope: a defect outside the assigned ranges belongs to another agent.
      expect(prompt).toContain('Review only the diff ranges you were assigned');
      // The output contract the orchestrator's aggregation depends on.
      expect(prompt).toContain(
        'Report findings in the format your brief specifies',
      );
      // A question would block forever — these run with no human in the loop.
      expect(prompt).toContain('never ask a question');
    });

    it('omits the tools that would re-open the inherited surface', () => {
      const tools =
        BuiltinAgentRegistry.getBuiltinAgent(REVIEW_BUILTIN_SUBAGENT_TYPE)
          ?.tools ?? [];

      // TOOL_SEARCH lets an agent reveal deferred tools at runtime, and
      // revealDeferredTool writes to the registry the parent session shares —
      // one agent's discovery would rewrite the orchestrator's declarations
      // and void its prompt-cache prefix.
      expect(tools).not.toContain(ToolNames.TOOL_SEARCH);
      // SKILL is not merely unused: its presence injects the per-launch skills
      // catalogue into the agent's first user turn, which measured 3,623
      // tokens against 504 without it.
      expect(tools).not.toContain(ToolNames.SKILL);
      // A review dimension does not spawn further agents.
      expect(tools).not.toContain(ToolNames.AGENT);
    });

    it('leaves general-purpose as the only builtin that inherits every tool', () => {
      // general-purpose inherits everything by design; every other builtin
      // must declare a list, or it silently inherits the same surface.
      const inheriting = BuiltinAgentRegistry.getBuiltinAgents()
        .filter((agent) => !agent.tools || agent.tools.length === 0)
        .map((agent) => agent.name);

      expect(inheriting).toEqual([DEFAULT_BUILTIN_SUBAGENT_TYPE]);
    });
  });
});
