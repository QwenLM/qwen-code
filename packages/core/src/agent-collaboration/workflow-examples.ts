/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { createAndExecuteProjectWorkflow } from './project-workflow.js';

/**
 * Example usage of the multi-agent team collaboration system
 * This demonstrates how to use the built-in agents in a coordinated workflow
 */

/**
 * Example 1: Create a complete project workflow
 */
export async function exampleProjectWorkflow(config: Config) {
  console.log('Starting multi-agent team collaboration for a new project...');

  const projectOptions = {
    projectName: 'ecommerce-platform',
    projectGoal:
      'Build a scalable e-commerce platform with user authentication, product catalog, shopping cart, and payment processing',
    timeline: '3 months',
    stakeholders: ['Product Manager', 'Development Team', 'QA Team'],
    constraints: ['Budget', 'Timeline', 'Security Requirements'],
  };

  try {
    // Execute the complete workflow with all agents collaborating
    const results = await createAndExecuteProjectWorkflow(
      config,
      projectOptions,
    );

    console.log('Project workflow completed successfully!');
    console.log('Results by phase:');

    console.log(
      'Project Phase:',
      typeof results['projectPhase'] === 'string'
        ? results['projectPhase'].substring(0, 100) + '...'
        : 'Object result',
    );

    console.log(
      'Planning Phase:',
      typeof results['planningPhase'] === 'string'
        ? results['planningPhase'].substring(0, 100) + '...'
        : 'Object result',
    );

    console.log(
      'Research Phase:',
      typeof results['researchPhase'] === 'object'
        ? JSON.stringify(results['researchPhase'], null, 2).substring(0, 100) +
            '...'
        : 'String result',
    );

    console.log(
      'Design Phase:',
      typeof results['designPhase'] === 'string'
        ? results['designPhase'].substring(0, 100) + '...'
        : 'Object result',
    );

    console.log(
      'Implementation Phase:',
      typeof results['implementationPhase'] === 'string'
        ? results['implementationPhase'].substring(0, 100) + '...'
        : 'Object result',
    );

    console.log(
      'Testing Phase:',
      typeof results['testingPhase'] === 'string'
        ? results['testingPhase'].substring(0, 100) + '...'
        : 'Object result',
    );

    console.log(
      'Review Phase:',
      typeof results['review'] === 'string'
        ? results['review'].substring(0, 100) + '...'
        : 'Object result',
    );

    return results;
  } catch (error) {
    console.error('Project workflow failed:', error);
    throw error;
  }
}

/**
 * Example 2: Create a simplified project workflow focused on specific phases
 */
export async function exampleFocusedWorkflow(config: Config) {
  console.log('Starting focused multi-agent collaboration...');

  const projectOptions = {
    projectName: 'api-security-enhancement',
    projectGoal: 'Improve the security of existing API endpoints',
  };

  try {
    const results = await createAndExecuteProjectWorkflow(
      config,
      projectOptions,
    );
    console.log('Focused workflow completed!');
    return results;
  } catch (error) {
    console.error('Focused workflow failed:', error);
    throw error;
  }
}

/**
 * Example 3: Using the orchestrator directly for more control
 */
export async function exampleDirectOrchestration(config: Config) {
  console.log('Using direct orchestration with more control...');

  const { ProjectWorkflowOrchestrator } = await import('./project-workflow.js');

  const orchestrator = new ProjectWorkflowOrchestrator(config, {
    projectName: 'performance-optimization',
    projectGoal: 'Optimize the performance of the user dashboard',
  });

  try {
    // Create the workflow steps
    const steps = await orchestrator.createProjectWorkflow();
    console.log(`Created workflow with ${steps.length} steps`);

    // Execute as a coordinated workflow
    const result = await orchestrator.executeAsWorkflow();
    console.log('Direct orchestration completed!');
    return result;
  } catch (error) {
    console.error('Direct orchestration failed:', error);
    throw error;
  }
}
