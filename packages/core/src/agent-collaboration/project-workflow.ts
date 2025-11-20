/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  createAgentCollaborationAPI,
  type AgentCollaborationAPI,
  type EnhancedAgentCollaborationAPI,
  createEnhancedAgentCollaborationAPI,
} from './index.js';
import type { AgentWorkflowStep } from './agent-orchestration.js';
import type { EnhancedAgentOrchestrationSystem } from './enhanced-coordination.js';

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
  enableEnhancedCoordination?: boolean; // Whether to use enhanced coordination
  collaborationStrategy?:
    | 'sequential'
    | 'parallel'
    | 'round-robin'
    | 'specialized'
    | 'hybrid'; // Strategy for agent collaboration
  enableRecovery?: boolean; // Whether to enable workflow recovery
  maxRetries?: number; // Maximum number of retries for failed steps
}

/**
 * Enhanced project workflow orchestrator with improved team workflow execution
 */
export class ProjectWorkflowOrchestrator {
  private readonly api: AgentCollaborationAPI;
  private readonly enhancedApi?: EnhancedAgentCollaborationAPI;
  private readonly config: Config;
  private readonly options: ProjectWorkflowOptions;

  constructor(config: Config, options: ProjectWorkflowOptions) {
    this.config = config;
    this.options = {
      enableEnhancedCoordination: false,
      collaborationStrategy: 'sequential',
      enableRecovery: true,
      maxRetries: 3,
      ...options,
    };

    // Initialize appropriate API based on options
    if (this.options.enableEnhancedCoordination) {
      this.enhancedApi = createEnhancedAgentCollaborationAPI(config);
      // Use a type assertion since EnhancedAgentCollaborationAPI extends AgentCollaborationAPI
      this.api = this.enhancedApi as unknown as AgentCollaborationAPI;
    } else {
      this.api = createAgentCollaborationAPI(config);
    }

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

    try {
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

      // Update team progress
      await this.api.memory.updateTeamProgress(
        this.options.projectName,
        100,
        'completed',
        results,
      );
    } catch (error) {
      console.error('Project workflow failed:', error);

      // Store error in shared memory
      await this.api.memory.set(`project:${this.options.projectName}:error`, {
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
        phase: Object.keys(results).pop() || 'unknown',
      });

      // If recovery is enabled and enhanced coordination is available, try to recover
      if (this.options.enableRecovery && this.enhancedApi) {
        console.log('Attempting workflow recovery...');
        return this.recoverFromFailure(results);
      }

      throw error;
    }

    return results;
  }

  /**
   * Attempt to recover from a failed workflow
   */
  private async recoverFromFailure(
    currentResults: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.enhancedApi) {
      throw new Error('Recovery requires enhanced coordination API');
    }

    const recoveryResults = { ...currentResults };

    // Use enhanced orchestration for recovery
    const workflowId = `recovery-${this.options.projectName}-${Date.now()}`;

    try {
      // Get the failed workflow
      const recoveryOption: 'retryFailedSteps' | 'skipFailedSteps' =
        'retryFailedSteps';

      // Attempt recovery using the enhanced orchestration system
      const recoveryResult =
        await this.enhancedApi.orchestration.recoverWorkflow(
          workflowId,
          recoveryOption,
        );

      return { ...recoveryResults, recovery: recoveryResult };
    } catch (recoveryError) {
      console.error('Recovery failed:', recoveryError);
      throw recoveryError;
    }
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
      status: 'active',
      progress: 0,
      completedTasks: [],
    });

    // Register all agents in their contexts with enhanced information
    for (const agent of agents) {
      await this.api.memory.set(`agent:${agent.name}:context`, {
        team: teamName,
        role: agent.role,
        task: this.options.projectGoal,
        assignedTasks: [],
        completedTasks: [],
        dependencies: [], // Tasks this agent is waiting for
        dependents: [], // Tasks that depend on this agent's work
        status: 'ready',
      });
    }

    // Initialize the shared context with project-wide information
    await this.api.memory.set(`project:${teamName}:shared-context`, {
      projectName: teamName,
      projectGoal: this.options.projectGoal,
      timeline: this.options.timeline,
      stakeholders: this.options.stakeholders,
      constraints: this.options.constraints,
      currentPhase: 'initial',
      progress: 0,
      lastUpdated: new Date().toISOString(),
      communicationLog: [],
      decisions: {},
    });
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

    // Check for dependencies before starting
    await this.waitForDependencies(['initial']);

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

    // Update team progress
    await this.api.memory.updateTeamProgress(
      this.options.projectName,
      15, // First phase is 15% of progress
      'project',
      { plan: result },
    );

    // Update agent context to indicate completion
    await this.api.memory.update(`agent:project-manager:context`, {
      completedTasks: ['project-phase'],
      status: 'completed',
    });

    // Add to communication log
    await this.logCommunication(
      'project-manager',
      'project-phase-completed',
      result,
    );

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
   * Waits for specified dependencies to be completed before proceeding
   */
  private async waitForDependencies(dependencies: string[]): Promise<void> {
    // In a real implementation, this would wait for dependencies to be completed
    // For now, we'll just check if the expected keys exist in memory
    for (const dep of dependencies) {
      if (dep !== 'initial') {
        // Wait for the dependency to be completed
        let dependencyCompleted = false;
        let attempts = 0;
        const maxAttempts = 10; // Prevent infinite loops

        while (!dependencyCompleted && attempts < maxAttempts) {
          // Check if the dependency has been completed by looking for its results in memory
          const depKey = dep.includes('-phase')
            ? `project:${this.options.projectName}:${dep.replace('-phase', '')}`
            : `project:${this.options.projectName}:${dep}`;

          const depResult = await this.api.memory.get(depKey);
          if (depResult) {
            dependencyCompleted = true;
          } else {
            // Wait a bit before checking again
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          attempts++;
        }

        if (!dependencyCompleted) {
          console.warn(
            `Dependency ${dep} not completed after ${maxAttempts} attempts`,
          );
        }
      }
    }
  }

  /**
   * Logs communication between agents for traceability
   */
  private async logCommunication(
    agent: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      agent,
      event,
      data:
        typeof data === 'string'
          ? data.substring(0, 200)
          : JSON.stringify(data).substring(0, 200),
    };

    // Add to the project's communication log
    const logKey = `project:${this.options.projectName}:communication-log`;
    const currentLog: unknown[] = (await this.api.memory.get(logKey)) || [];
    currentLog.push(logEntry);
    await this.api.memory.set(logKey, currentLog);

    // Also add to the shared context
    const sharedContextKey = `project:${this.options.projectName}:shared-context`;
    const sharedContext =
      (await this.api.memory.get<Record<string, unknown>>(sharedContextKey)) ||
      {};
    const communicationLog =
      (sharedContext['communicationLog'] as unknown[]) || [];
    communicationLog.push(logEntry);
    await this.api.memory.update(sharedContextKey, { communicationLog });
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
        retryCount: this.options.maxRetries,
      },

      // Planning Phase (depends on project phase)
      {
        id: 'planning-phase',
        agent: 'deep-planner',
        task: `Create master plan for: ${this.options.projectGoal}`,
        dependencies: ['project-phase-start'],
        retryCount: this.options.maxRetries,
      },

      // Research Phase (depends on planning)
      {
        id: 'research-phase',
        agent: 'deep-researcher',
        task: `Conduct research for: ${this.options.projectGoal}`,
        dependencies: ['planning-phase'],
        retryCount: this.options.maxRetries,
      },
      // Also include web research
      {
        id: 'web-research-phase',
        agent: 'deep-web-search',
        task: `Perform web research for: ${this.options.projectGoal}`,
        dependencies: ['research-phase'],
        retryCount: this.options.maxRetries,
      },

      // Design Phase (depends on research)
      {
        id: 'design-phase',
        agent: 'software-architecture',
        task: `Design system architecture for: ${this.options.projectGoal}`,
        dependencies: ['web-research-phase'],
        retryCount: this.options.maxRetries,
      },

      // Implementation Phase (depends on design)
      {
        id: 'implementation-phase',
        agent: 'software-engineer',
        task: `Implement solution for: ${this.options.projectGoal}`,
        dependencies: ['design-phase'],
        retryCount: this.options.maxRetries,
      },

      // Testing Phase (depends on implementation)
      {
        id: 'testing-phase',
        agent: 'software-tester',
        task: `Validate implementation for: ${this.options.projectGoal}`,
        dependencies: ['implementation-phase'],
        retryCount: this.options.maxRetries,
      },

      // Final review (depends on testing)
      {
        id: 'final-review',
        agent: 'general-purpose',
        task: `Conduct final review for: ${this.options.projectGoal}`,
        dependencies: ['testing-phase'],
        retryCount: this.options.maxRetries,
      },
    ];
  }

  /**
   * Execute the workflow using the orchestration system
   */
  async executeAsWorkflow(): Promise<unknown> {
    const workflowSteps = await this.createProjectWorkflow();

    // Use enhanced orchestration if available
    if (this.enhancedApi) {
      // Type assertion to allow usage of enhanced orchestration
      const enhancedOrchestration = this.enhancedApi
        .orchestration as EnhancedAgentOrchestrationSystem;
      return enhancedOrchestration.executeWorkflowWithTracking(
        `workflow-${this.options.projectName}-${Date.now()}`,
        `Project Workflow: ${this.options.projectName}`,
        `Complete project workflow for: ${this.options.projectGoal}`,
        workflowSteps,
      );
    } else {
      return this.api.orchestration.executeWorkflow(
        `workflow-${this.options.projectName}-${Date.now()}`,
        `Project Workflow: ${this.options.projectName}`,
        `Complete project workflow for: ${this.options.projectGoal}`,
        workflowSteps,
        this.options.collaborationStrategy,
      );
    }
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
