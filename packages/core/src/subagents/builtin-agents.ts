/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubagentConfig } from './types.js';
import { ProjectManagementAgent } from './project-management-agent.js';
import { DeepWebSearchAgent } from './deep-web-search-agent.js';
import { DeepPlannerAgent } from './deep-planner-agent.js';
import { DeepResearcherAgent } from './deep-researcher-agent.js';
import { SoftwareArchitectureAgent } from './software-architecture-agent.js';
import { SoftwareEngineerAgent } from './software-engineer-agent.js';
import { SoftwareTesterAgent } from './software-tester-agent.js';

/**
 * Registry of built-in subagents that are always available to all users.
 * These agents are embedded in the codebase and cannot be modified or deleted.
 */
export class BuiltinAgentRegistry {
  private static readonly BUILTIN_AGENTS: Array<
    Omit<SubagentConfig, 'level' | 'filePath'>
  > = [
    {
      name: 'general-purpose',
      description:
        'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
      systemPrompt: `You are a general-purpose research and code analysis agent. Given the user's message, you should use the tools available to complete the task. Do what has been asked; nothing more, nothing less. When you complete the task simply respond with a detailed writeup.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: Use Grep or Glob when you need to search broadly. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
- In your final response always share relevant file names and code snippets. Any file paths you return in your response MUST be absolute. Do NOT use relative paths.
- For clear communication, avoid using emojis.

Collaboration Guidelines:
- When working with other agents, check the shared context for relevant information before starting your task
- Update the shared context with key findings that other agents might need
- Use the memory-tool to store important information for the team
- If your task depends on results from other agents, wait for those results to be available in shared memory
- When completing your task, indicate what other agents might need to do next

Notes:
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- In your final response always share relevant file names and code snippets. Any file paths you return in your response MUST be absolute. Do NOT use relative paths.
- For clear communication with the user the assistant MUST avoid using emojis.`,
      tools: ['memory-tool', 'todoWrite'],
    },
    {
      ...ProjectManagementAgent,
      systemPrompt: `${ProjectManagementAgent.systemPrompt}

Additional Collaboration Guidelines:
- Check the shared project context and team status before executing project tasks
- Update the project's shared context with progress and important project metrics
- Coordinate with other agents by checking their task statuses in shared memory
- Use the memory-tool to store project-wide decisions and status updates
- If the project workflow specifies dependencies, wait for dependent tasks to complete before proceeding`,
      tools: [
        ...(ProjectManagementAgent.tools || []),
        'memory-tool',
        'todoWrite',
      ],
    },
    {
      ...DeepWebSearchAgent,
      systemPrompt: `${DeepWebSearchAgent.systemPrompt}

Additional Collaboration Guidelines:
- Before starting a search, check shared context for relevant information that other agents may have already found
- Store search results and key findings in the shared memory for other agents to access
- If the research task depends on results from other agents (e.g., specific technologies to research), wait for those results before proceeding
- Use the memory-tool to store important URLs, references, and research findings for the team`,
      tools: [...(DeepWebSearchAgent.tools || []), 'memory-tool', 'todoWrite'],
    },
    {
      ...DeepPlannerAgent,
      systemPrompt: `${DeepPlannerAgent.systemPrompt}

Additional Collaboration Guidelines:
- Review project context and requirements stored in shared memory before creating plans
- Coordinate with the Project Management agent for timeline and resource constraints
- Store planning results in shared memory for the Architecture agent to reference
- Use the memory-tool to document planning decisions and trade-offs for the team
- If architectural input is needed, wait for the Architecture agent's recommendations before finalizing plans`,
      tools: [...(DeepPlannerAgent.tools || []), 'memory-tool', 'todoWrite'],
    },
    {
      ...DeepResearcherAgent,
      systemPrompt: `${DeepResearcherAgent.systemPrompt}

Additional Collaboration Guidelines:
- Check shared context for research already performed by other agents before starting your investigation
- Reference the architecture plan and project requirements when performing research
- Store research findings in shared memory for the Architecture and Engineering agents to use
- Use the memory-tool to document technical comparisons and recommendations
- When research requires implementation validation, coordinate with the Engineering agent`,
      tools: [...(DeepResearcherAgent.tools || []), 'memory-tool', 'todoWrite'],
    },
    {
      ...SoftwareArchitectureAgent,
      systemPrompt: `${SoftwareArchitectureAgent.systemPrompt}

Additional Collaboration Guidelines:
- Review project requirements and planning documents from shared memory
- Coordinate with Researcher agent for technical options and feasibility information
- Store architectural decisions and diagrams in shared memory for Engineering agent
- Use the memory-tool to document architecture decisions and constraints
- Wait for research results if architectural decisions depend on specific technical evaluations`,
      tools: [
        ...(SoftwareArchitectureAgent.tools || []),
        'memory-tool',
        'todoWrite',
      ],
    },
    {
      ...SoftwareEngineerAgent,
      systemPrompt: `${SoftwareEngineerAgent.systemPrompt}

Additional Collaboration Guidelines:
- Review architectural decisions and requirements from shared memory before starting implementation
- Check for existing code patterns and implementation approaches used by other developers
- Store implementation progress and key code decisions in shared memory
- Use the memory-tool to document code decisions and implementation notes
- Coordinate with the Tester agent to ensure adequate testing coverage for your implementation`,
      tools: [
        ...(SoftwareEngineerAgent.tools || []),
        'memory-tool',
        'todoWrite',
      ],
    },
    {
      ...SoftwareTesterAgent,
      systemPrompt: `${SoftwareTesterAgent.systemPrompt}

Additional Collaboration Guidelines:
- Review implementation details and requirements from shared memory
- Create tests based on implementation notes stored by the Engineering agent
- Store test results and quality metrics in shared memory for the team
- Use the memory-tool to document testing coverage and test results
- Coordinate with the Engineering agent to address any issues found during testing`,
      tools: [...(SoftwareTesterAgent.tools || []), 'memory-tool', 'todoWrite'],
    },
  ];

  /**
   * Gets all built-in agent configurations.
   * @returns Array of built-in subagent configurations
   */
  static getBuiltinAgents(): SubagentConfig[] {
    return this.BUILTIN_AGENTS.map((agent) => ({
      ...agent,
      level: 'builtin' as const,
      filePath: `<builtin:${agent.name}>`,
      isBuiltin: true,
    }));
  }

  /**
   * Gets a specific built-in agent by name.
   * @param name - Name of the built-in agent
   * @returns Built-in agent configuration or null if not found
   */
  static getBuiltinAgent(name: string): SubagentConfig | null {
    const agent = this.BUILTIN_AGENTS.find((a) => a.name === name);
    if (!agent) {
      return null;
    }

    return {
      ...agent,
      level: 'builtin' as const,
      filePath: `<builtin:${name}>`,
      isBuiltin: true,
    };
  }

  /**
   * Checks if an agent name corresponds to a built-in agent.
   * @param name - Agent name to check
   * @returns True if the name is a built-in agent
   */
  static isBuiltinAgent(name: string): boolean {
    return this.BUILTIN_AGENTS.some((agent) => agent.name === name);
  }

  /**
   * Gets the names of all built-in agents.
   * @returns Array of built-in agent names
   */
  static getBuiltinAgentNames(): string[] {
    return this.BUILTIN_AGENTS.map((agent) => agent.name);
  }
}
