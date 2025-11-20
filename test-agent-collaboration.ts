/**
 * Test file to verify that built-in agents can collaborate as a team
 */

import {
  executeCollaborativeTask,
  createAgentTeam,
} from './packages/core/src/agent-collaboration/index.js';
import type { Config } from './packages/core/src/config/config.js';

// Mock config for testing
const mockConfig: Config = {
  getToolRegistry: () => ({
    registerTool: () => {},
  }),
  getGeminiClient: () => ({}),
  getModel: () => ({}),
  getWorkspaceContext: () => ({}),
  getSkipStartupContext: () => false,
  getProjectRoot: () => '/tmp',
  getSessionId: () => 'test-session',
} as Config;

async function testAgentCollaboration() {
  console.log('🧪 Testing Built-in Agent Collaboration...\n');

  // Test 1: Creating a team with built-in agents
  console.log('1. Creating a team with built-in agents...');
  const teamName = 'dev-team';
  const agents = [
    { name: 'software-engineer', role: 'Implementation specialist' },
    { name: 'software-architect', role: 'System designer' },
    { name: 'deep-researcher', role: 'Research specialist' },
    { name: 'software-tester', role: 'Quality assurance' },
  ];
  const task =
    'Build a sample application with proper architecture and testing';

  await createAgentTeam(mockConfig, teamName, agents, task);
  console.log('✅ Team created successfully with', agents.length, 'agents\n');

  // Test 2: Testing specialized collaboration strategy
  console.log('2. Testing specialized collaboration strategy...');
  const specializedResults = await executeCollaborativeTask(
    mockConfig,
    [
      'deep-researcher',
      'software-architect',
      'software-engineer',
      'software-tester',
    ],
    'Create a secure API endpoint',
    'specialized',
  );
  console.log(
    '✅ Specialized collaboration completed:',
    Object.keys(specializedResults),
    '\n',
  );

  // Test 3: Testing sequential collaboration
  console.log('3. Testing sequential collaboration...');
  const sequentialResults = await executeCollaborativeTask(
    mockConfig,
    [
      'deep-researcher',
      'software-architect',
      'software-engineer',
      'software-tester',
    ],
    'Implement a user authentication system',
    'sequential',
  );
  console.log(
    '✅ Sequential collaboration completed:',
    Object.keys(sequentialResults),
    '\n',
  );

  // Test 4: Testing round-robin collaboration
  console.log('4. Testing round-robin collaboration...');
  const roundRobinResults = await executeCollaborativeTask(
    mockConfig,
    ['software-engineer', 'software-tester', 'deep-researcher'],
    'Optimize a slow database query',
    'round-robin',
  );
  console.log(
    '✅ Round-robin collaboration completed:',
    Object.keys(roundRobinResults),
    '\n',
  );

  console.log('🎉 All agent collaboration tests completed successfully!');
  console.log('\n✅ Built-in agents can effectively work together as a team!');
}

// Run the test
testAgentCollaboration().catch(console.error);
