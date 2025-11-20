/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  createAgentCollaborationAPI,
  type AgentCollaborationAPI,
} from './index.js';
import type { AgentWorkflowStep } from './agent-orchestration.js';

/**
 * Defines the roles and responsibilities for each agent in the project workflow
 */
export interface ProjectAgentTeam {
  supervisor: 'general-purpose';
  researcher: 'deep-web-search';
  projectManager: 'project-manager';
  planner: 'deep-planner';
  deepResearcher: 'deep-researcher';
  architect: 'software-architecture';
  engineer: 'software-engineer';
  tester: 'software-tester';
}

/**
 * Defines the workflow phases for a complete project lifecycle
 */
export interface ProjectWorkflowPhases {
  projectPhase: AgentWorkflowStep[];
  planningPhase: AgentWorkflowStep[];
  researchPhase: AgentWorkflowStep[];
  designPhase: AgentWorkflowStep[];
  implementationPhase: AgentWorkflowStep[];
  testingPhase: AgentWorkflowStep[];
}

/**
 * Configuration options for the project workflow
 */
export interface ProjectWorkflowOptions {
  projectName: string;
  projectGoal: string;
  timeline?: string;
  stakeholders?: string[];
  constraints?: string[];
}

/**
 * A complete project workflow implementation that orchestrates all built-in agents
 * to work together effectively across multiple phases of a software project.
 */
export class ProjectWorkflowOrchestrator {
  private readonly api: AgentCollaborationAPI;
  private readonly config: Config;
  private readonly options: ProjectWorkflowOptions;

  constructor(config: Config, options: ProjectWorkflowOptions) {
    this.config = config;
    this.api = createAgentCollaborationAPI(config);
    this.options = options;

    // Use config to prevent unused variable error
    void this.config;
  }

  /**
   * Executes the complete project workflow with all agents collaborating
   */
  async executeCompleteWorkflow(): Promise<Record<string, unknown>> {
    // Create the project team in shared memory
    await this.createProjectTeam();

    // Execute all phases in sequence with proper dependencies
    const results: Record<string, unknown> = {};

    // Phase 1: Project Management
    results['projectPhase'] = await this.executeProjectPhase();

    // Phase 2: Planning
    results['planningPhase'] = await this.executePlanningPhase();

    // Phase 3: Research
    results['researchPhase'] = await this.executeResearchPhase();

    // Phase 4: Design
    results['designPhase'] = await this.executeDesignPhase();

    // Phase 5: Implementation
    results['implementationPhase'] = await this.executeImplementationPhase();

    // Phase 6: Testing
    results['testingPhase'] = await this.executeTestingPhase();

    // Final review by supervisor
    results['review'] = await this.executeFinalReview();

    return results;
  }

  /**
   * Creates the project team with all agents and their roles
   */
  private async createProjectTeam(): Promise<void> {
    const teamName = this.options.projectName;
    const agents = [
      {
        name: 'general-purpose',
        role: 'Supervisor - Critical thinking, oversight, and overall control',
      },
      {
        name: 'deep-web-search',
        role: 'Research Specialist - Web research and information gathering',
      },
      {
        name: 'project-manager',
        role: 'Project Manager - Manage resources, targets and project tasks',
      },
      {
        name: 'deep-planner',
        role: 'Master Planner - Strategic planning and architecture design',
      },
      {
        name: 'deep-researcher',
        role: 'In-depth Researcher - Investigate technical solutions',
      },
      {
        name: 'software-architecture',
        role: 'System Architect - Design system architecture',
      },
      {
        name: 'software-engineer',
        role: 'Implementation Engineer - Build the solution based on design',
      },
      {
        name: 'software-tester',
        role: 'Quality Assurance - Validate implementation',
      },
    ];

    // Store team in shared memory
    await this.api.memory.set(`project-team:${teamName}`, {
      name: teamName,
      agents,
      goal: this.options.projectGoal,
      created: new Date().toISOString(),
    });

    // Register all agents in their contexts
    for (const agent of agents) {
      await this.api.memory.set(`agent:${agent.name}:context`, {
        team: teamName,
        role: agent.role,
        task: this.options.projectGoal,
      });
    }
  }

  /**
   * Executes the project management phase
   */
  private async executeProjectPhase(): Promise<unknown> {
    const taskDescription = `
      Initialize project management for: ${this.options.projectGoal}
      Project: ${this.options.projectName}
      Timeline: ${this.options.timeline || 'Not specified'}
      Stakeholders: ${this.options.stakeholders?.join(', ') || 'Not specified'}
      Constraints: ${this.options.constraints?.join(', ') || 'None specified'}
      
      As the project-manager agent, you need to:
      1. Define project scope and objectives
      2. Identify key stakeholders and their needs
      3. Establish project timeline and milestones
      4. List required resources and constraints
      5. Create initial project plan
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'project-manager',
        `Manage the project: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store the project plan in shared memory for other agents to reference
    await this.api.memory.set(`project:${this.options.projectName}:plan`, {
      task: taskDescription,
      result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Executes the planning phase
   */
  private async executePlanningPhase(): Promise<unknown> {
    const projectPlan = await this.api.memory.get(
      `project:${this.options.projectName}:plan`,
    );

    const taskDescription = `
      Create a master plan for: ${this.options.projectGoal}
      Based on project plan: ${JSON.stringify(projectPlan)}
      
      As the deep-planner agent, you need to:
      1. Create a detailed technical architecture plan
      2. Define system components and their interactions
      3. Specify technology stack and tools
      4. Outline development phases and deliverables
      5. Identify potential risks and mitigation strategies
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'deep-planner',
        `Plan the architecture for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store the master plan in shared memory
    await this.api.memory.set(
      `project:${this.options.projectName}:master-plan`,
      {
        task: taskDescription,
        result,
        timestamp: new Date().toISOString(),
      },
    );

    return result;
  }

  /**
   * Executes the research phase
   */
  private async executeResearchPhase(): Promise<unknown> {
    const masterPlan = await this.api.memory.get(
      `project:${this.options.projectName}:master-plan`,
    );

    const taskDescription = `
      Conduct in-depth research for: ${this.options.projectGoal}
      Based on master plan: ${JSON.stringify(masterPlan)}
      
      As the deep-researcher agent, you need to:
      1. Research best practices for the proposed technologies
      2. Investigate alternative solutions and compare them
      3. Study similar implementations and learn from them
      4. Gather information about scalability, security, and performance considerations
      5. Provide recommendations for technology choices
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'deep-researcher',
        `Research for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Also use deep-web-search for additional web research
    const webResearchTask = `
      Perform web research to complement the deep research.
      Focus on: ${this.options.projectGoal}
      Current research findings: ${JSON.stringify(result).substring(0, 500)}...
      
      As the deep-web-search agent, find additional resources, articles, and documentation.
      Look for: best practices, common pitfalls, successful implementations, expert opinions.
    `;

    const webResult = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'deep-web-search',
        `Web research for: ${this.options.projectGoal}`,
        webResearchTask,
      );

    // Combine both research results
    const combinedResult = {
      deepResearch: result,
      webResearch: webResult,
      synthesis: `Combined research findings for ${this.options.projectGoal}`,
    };

    // Store research results
    await this.api.memory.set(`project:${this.options.projectName}:research`, {
      task: taskDescription,
      result: combinedResult,
      timestamp: new Date().toISOString(),
    });

    return combinedResult;
  }

  /**
   * Executes the design phase
   */
  private async executeDesignPhase(): Promise<unknown> {
    const researchResults = await this.api.memory.get(
      `project:${this.options.projectName}:research`,
    );
    const masterPlan = await this.api.memory.get(
      `project:${this.options.projectName}:master-plan`,
    );

    const taskDescription = `
      Design the system architecture for: ${this.options.projectGoal}
      Based on master plan: ${JSON.stringify(masterPlan)}
      Research findings: ${JSON.stringify(researchResults)}
      
      As the software-architecture agent, you need to:
      1. Design the detailed system architecture
      2. Define component interactions and data flow
      3. Specify API contracts and interfaces
      4. Address scalability, security, and performance requirements
      5. Create architectural diagrams and documentation
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'software-architecture',
        `Design architecture for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store design results
    await this.api.memory.set(`project:${this.options.projectName}:design`, {
      task: taskDescription,
      result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Executes the implementation phase
   */
  private async executeImplementationPhase(): Promise<unknown> {
    const design = await this.api.memory.get(
      `project:${this.options.projectName}:design`,
    );
    const research = await this.api.memory.get(
      `project:${this.options.projectName}:research`,
    );

    const taskDescription = `
      Implement the solution based on the design for: ${this.options.projectGoal}
      System design: ${JSON.stringify(design)}
      Research findings: ${JSON.stringify(research)}
      
      As the software-engineer agent, you need to:
      1. Write clean, efficient code based on the architecture
      2. Implement core functionality as per requirements
      3. Follow best practices and coding standards
      4. Write modular, maintainable code
      5. Document your implementation appropriately
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'software-engineer',
        `Implement solution for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store implementation results
    await this.api.memory.set(
      `project:${this.options.projectName}:implementation`,
      {
        task: taskDescription,
        result,
        timestamp: new Date().toISOString(),
      },
    );

    return result;
  }

  /**
   * Executes the testing phase
   */
  private async executeTestingPhase(): Promise<unknown> {
    const implementation = await this.api.memory.get(
      `project:${this.options.projectName}:implementation`,
    );
    const design = await this.api.memory.get(
      `project:${this.options.projectName}:design`,
    );

    const taskDescription = `
      Validate the implementation for: ${this.options.projectGoal}
      Implementation: ${JSON.stringify(implementation)}
      Design requirements: ${JSON.stringify(design)}
      
      As the software-tester agent, you need to:
      1. Write comprehensive unit tests
      2. Create integration tests
      3. Perform code quality analysis
      4. Identify potential bugs or issues
      5. Validate against original requirements
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'software-tester',
        `Test the implementation for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store testing results
    await this.api.memory.set(`project:${this.options.projectName}:testing`, {
      task: taskDescription,
      result,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  /**
   * Executes a final review by the supervisor
   */
  private async executeFinalReview(): Promise<unknown> {
    const projectPhases = [
      await this.api.memory.get(`project:${this.options.projectName}:plan`),
      await this.api.memory.get(
        `project:${this.options.projectName}:master-plan`,
      ),
      await this.api.memory.get(`project:${this.options.projectName}:research`),
      await this.api.memory.get(`project:${this.options.projectName}:design`),
      await this.api.memory.get(
        `project:${this.options.projectName}:implementation`,
      ),
      await this.api.memory.get(`project:${this.options.projectName}:testing`),
    ];

    const taskDescription = `
      Conduct a final review of the complete project for: ${this.options.projectGoal}
      Project summary:
      - Project Plan: ${JSON.stringify(projectPhases[0])?.substring(0, 300)}...
      - Master Plan: ${JSON.stringify(projectPhases[1])?.substring(0, 300)}...
      - Research: ${JSON.stringify(projectPhases[2])?.substring(0, 300)}...
      - Design: ${JSON.stringify(projectPhases[3])?.substring(0, 300)}...
      - Implementation: ${JSON.stringify(projectPhases[4])?.substring(0, 300)}...
      - Testing: ${JSON.stringify(projectPhases[5])?.substring(0, 300)}...
      
      As the general-purpose supervisor agent, you need to:
      1. Critically evaluate the work done in all phases
      2. Identify any gaps or inconsistencies
      3. Assess the overall quality and completeness
      4. Suggest improvements or next steps
      5. Provide a final assessment of the project
    `;

    const result = await this.api.coordination
      .getAgentsManager()
      .executeAgent(
        'general-purpose',
        `Final review for: ${this.options.projectGoal}`,
        taskDescription,
      );

    // Store final review
    await this.api.memory.set(
      `project:${this.options.projectName}:final-review`,
      {
        task: taskDescription,
        result,
        timestamp: new Date().toISOString(),
      },
    );

    return result;
  }

  /**
   * Creates a coordinated workflow with all phases
   */
  async createProjectWorkflow(): Promise<AgentWorkflowStep[]> {
    return [
      // Project Phase
      {
        id: 'project-phase-start',
        agent: 'project-manager',
        task: `Initialize project management for: ${this.options.projectGoal}`,
      },

      // Planning Phase (depends on project phase)
      {
        id: 'planning-phase',
        agent: 'deep-planner',
        task: `Create master plan for: ${this.options.projectGoal}`,
        dependencies: ['project-phase-start'],
      },

      // Research Phase (depends on planning)
      {
        id: 'research-phase',
        agent: 'deep-researcher',
        task: `Conduct research for: ${this.options.projectGoal}`,
        dependencies: ['planning-phase'],
      },
      // Also include web research
      {
        id: 'web-research-phase',
        agent: 'deep-web-search',
        task: `Perform web research for: ${this.options.projectGoal}`,
        dependencies: ['research-phase'],
      },

      // Design Phase (depends on research)
      {
        id: 'design-phase',
        agent: 'software-architecture',
        task: `Design system architecture for: ${this.options.projectGoal}`,
        dependencies: ['web-research-phase'],
      },

      // Implementation Phase (depends on design)
      {
        id: 'implementation-phase',
        agent: 'software-engineer',
        task: `Implement solution for: ${this.options.projectGoal}`,
        dependencies: ['design-phase'],
      },

      // Testing Phase (depends on implementation)
      {
        id: 'testing-phase',
        agent: 'software-tester',
        task: `Validate implementation for: ${this.options.projectGoal}`,
        dependencies: ['implementation-phase'],
      },

      // Final review (depends on testing)
      {
        id: 'final-review',
        agent: 'general-purpose',
        task: `Conduct final review for: ${this.options.projectGoal}`,
        dependencies: ['testing-phase'],
      },
    ];
  }

  /**
   * Execute the workflow using the orchestration system
   */
  async executeAsWorkflow(): Promise<unknown> {
    const workflowSteps = await this.createProjectWorkflow();

    return this.api.orchestration.executeWorkflow(
      `workflow-${this.options.projectName}-${Date.now()}`,
      `Project Workflow: ${this.options.projectName}`,
      `Complete project workflow for: ${this.options.projectGoal}`,
      workflowSteps,
    );
  }
}

/**
 * Convenience function to create and execute a project workflow
 */
export async function createAndExecuteProjectWorkflow(
  config: Config,
  options: ProjectWorkflowOptions,
): Promise<Record<string, unknown>> {
  const orchestrator = new ProjectWorkflowOrchestrator(config, options);
  return orchestrator.executeCompleteWorkflow();
}
