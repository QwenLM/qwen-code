/**
 * Examples demonstrating the agent collaboration features
 */

import type { Config } from '../config/config.js';
import {
  createAgentCollaborationAPI,
  executeCollaborativeTask,
  createAgentTeam,
} from '../agent-collaboration/index.js';

// Example 1: Basic agent collaboration with shared memory
async function exampleBasicCollaboration(config: Config) {
  const api = createAgentCollaborationAPI(config);

  // Agent 1 stores information
  await api.memory.set('project:requirements', {
    name: 'New Feature',
    description: 'Implement user authentication system',
    priority: 'high',
    deadline: '2025-02-01',
  });

  // Agent 2 retrieves and builds upon the information
  const requirements = await api.memory.get('project:requirements');
  console.log('Requirements received:', requirements);

  // Agent 2 adds design decisions
  await api.memory.set('project:design', {
    architecture: 'microservices',
    technologies: ['TypeScript', 'Node.js', 'PostgreSQL'],
    decisions: 'Using JWT for auth, bcrypt for password hashing',
  });

  // Agent 3 combines both for implementation planning
  const design = await api.memory.get('project:design');
  console.log('Design decisions:', design);
}

// Example 2: Coordinated task execution
async function exampleCoordinatedTasks(config: Config) {
  const api = createAgentCollaborationAPI(config);

  // Assign tasks to different agents
  await api.coordination.assignTask(
    'task-1',
    'researcher',
    'Research authentication best practices',
  );
  await api.coordination.assignTask(
    'task-2',
    'architect',
    'Design system architecture',
  );
  await api.coordination.assignTask(
    'task-3',
    'engineer',
    'Implement authentication module',
  );

  // Start tasks
  await api.coordination.startTask('task-1', 'researcher');
  await api.coordination.startTask('task-2', 'architect');
  await api.coordination.startTask('task-3', 'engineer');

  // Simulate task completion (in a real scenario, agents would update their status)
  await api.coordination.completeTask('task-1', {
    bestPractices: [
      'use secure tokens',
      'implement rate limiting',
      'validate inputs',
    ],
  });
  await api.coordination.completeTask('task-2', {
    architecture: 'microservice with dedicated auth service',
  });
  await api.coordination.completeTask('task-3', {
    status: 'implementation complete',
    endpoint: '/api/auth/login',
  });

  // Check final status
  const task1Status = await api.coordination.getTaskStatus('task-1');
  console.log('Task 1 Result:', task1Status?.result);
}

// Example 3: Communication between agents
async function exampleAgentCommunication(config: Config) {
  const api = createAgentCollaborationAPI(config);

  // Agent 1 sends a message to Agent 2
  const messageId = await api.communication.sendMessage(
    'researcher',
    'architect',
    'request',
    {
      type: 'tech-decision',
      question: 'What auth method should we use?',
      options: ['JWT', 'OAuth2', 'Session-based'],
    },
  );

  console.log('Message sent with ID:', messageId);

  // Agent 2 responds to the request
  const response = await api.communication.sendRequestAndWait(
    'architect',
    'researcher',
    {
      answer: 'JWT is recommended for our use case',
      reasons: ['stateless', 'good for microservices', 'wide support'],
    },
  );

  console.log('Response received:', response);
}

// Example 4: Complex workflow orchestration
async function exampleWorkflowOrchestration(config: Config) {
  const api = createAgentCollaborationAPI(config);

  // Define a multi-step workflow
  const workflowSteps = [
    {
      id: 'analysis-step',
      agent: 'researcher',
      task: 'Analyze the current system and identify bottlenecks',
    },
    {
      id: 'design-step',
      agent: 'architect',
      task: 'Design a new system architecture',
      dependencies: ['analysis-step'],
    },
    {
      id: 'implementation-step',
      agent: 'engineer',
      task: 'Implement the new architecture',
      dependencies: ['design-step'],
    },
  ];

  try {
    const results = await api.orchestration.executeWorkflow(
      'workflow-1',
      'System Redesign',
      'Complete system redesign project',
      workflowSteps,
    );

    console.log('Workflow completed with results:', results);
  } catch (error) {
    console.error('Workflow failed:', error);
  }
}

// Example 5: Using collaborative task execution strategies
async function exampleCollaborativeStrategies(config: Config) {
  const agents = ['researcher', 'architect', 'engineer', 'tester'];
  const task = 'Build a complete software module';

  // Execute with different collaboration strategies
  console.log('Executing with parallel strategy...');
  const parallelResults = await executeCollaborativeTask(
    config,
    agents,
    task,
    'parallel',
  );
  console.log('Parallel results:', parallelResults);

  console.log('Executing with sequential strategy...');
  const sequentialResults = await executeCollaborativeTask(
    config,
    agents,
    task,
    'sequential',
  );
  console.log('Sequential results:', sequentialResults);

  console.log('Executing with round-robin strategy...');
  const roundRobinResults = await executeCollaborativeTask(
    config,
    agents,
    task,
    'round-robin',
  );
  console.log('Round-robin results:', roundRobinResults);
}

// Example 6: Creating an agent team for a specific project
async function exampleCreateAgentTeam(config: Config) {
  const teamName = 'auth-system-team';
  const agents = [
    { name: 'security-researcher', role: 'Security specialist' },
    { name: 'system-architect', role: 'Architecture designer' },
    { name: 'backend-engineer', role: 'Implementation specialist' },
    { name: 'qa-engineer', role: 'Testing specialist' },
  ];
  const task = 'Implement a secure authentication system';

  const api = await createAgentTeam(config, teamName, agents, task);

  console.log(`Team "${teamName}" created with ${agents.length} agents`);

  // Execute a collaborative task
  const results = await executeCollaborativeTask(
    config,
    agents.map((a) => a.name),
    task,
  );
  console.log('Team collaboration results:', results);

  return api; // Return api to avoid unused variable error
}

export {
  exampleBasicCollaboration,
  exampleCoordinatedTasks,
  exampleAgentCommunication,
  exampleWorkflowOrchestration,
  exampleCollaborativeStrategies,
  exampleCreateAgentTeam,
};
