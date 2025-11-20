/**
 * Example demonstrating how agent teams can build tools and agents dynamically
 * using the Qwen Code Agent Team API.
 */

import {
  createAgentTeamAPI,
  registerSimpleTool,
  executeSimpleAgent,
} from '../agent-team-api.js';
import type { Config } from '../config/config.js';

// Example 1: Using the full AgentTeamAPI
async function exampleUsingFullAPI(_config: Config) {
  // Create the agent team API
  const api = createAgentTeamAPI(_config);

  // Register a custom tool for searching code in the repository
  await api.tools.registerTool({
    name: 'code_search',
    description: 'Search for specific code patterns in the repository',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The code pattern to search for',
        },
        fileExtensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to search in (e.g., ["ts", "js"])',
        },
      },
      required: ['pattern'],
    },
    execute: async (params, _config) => {
      // This would actually search through the codebase
      const pattern = params['pattern'] as string;
      const extensions = (params['fileExtensions'] as string[]) || ['ts', 'js'];

      // For this example, just return a mock result
      return `Found 5 occurrences of "${pattern}" in ${extensions.join(', ')} files.`;
    },
  });

  // Create and run an agent that uses the custom tool
  const result = await api.agents.executeAgent(
    'code-analyzer-agent',
    'You are an expert code analyzer. Use the code_search tool to find specific patterns in the codebase.',
    'Find all occurrences of async functions in TypeScript files',
    ['code_search'], // Only allow our custom tool
  );

  console.log('Agent result:', result);
}

// Example 2: Using utility functions for simpler cases
async function exampleUsingUtilityFunctions(_config: Config) {
  // Register a simple tool directly
  await registerSimpleTool(
    _config,
    'calculator',
    'Performs basic mathematical calculations',
    {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
        },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['operation', 'a', 'b'],
    },
    async (params) => {
      const operation = params['operation'] as string;
      const a = params['a'] as number;
      const b = params['b'] as number;

      switch (operation) {
        case 'add':
          return a + b;
        case 'subtract':
          return a - b;
        case 'multiply':
          return a * b;
        case 'divide':
          return b !== 0 ? a / b : 'Error: Division by zero';
        default:
          return 'Error: Unknown operation';
      }
    },
  );

  // Execute an agent that uses the calculator tool
  const result = await executeSimpleAgent(
    _config,
    'math-agent',
    'You are a math assistant. Use the calculator tool to perform calculations.',
    'What is 24.5 multiplied by 17?',
    ['calculator'],
  );

  console.log('Math agent result:', result);
}

// Example 3: Creating a complex agent with multiple custom tools
async function exampleComplexAgent(_config: Config) {
  const api = createAgentTeamAPI(_config);

  // Register multiple related tools
  await api.tools.registerTool({
    name: 'get_user_info',
    description: 'Get information about a user',
    parameters: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
    execute: async (params) => {
      const userId = params['userId'] as string;
      // In a real implementation, this would fetch from a database
      return { id: userId, name: `User ${userId}`, role: 'developer' };
    },
  });

  await api.tools.registerTool({
    name: 'update_user_settings',
    description: 'Update user settings',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        settings: { type: 'object', additionalProperties: true },
      },
      required: ['userId', 'settings'],
    },
    execute: async (params) => {
      const userId = params['userId'] as string;
      const settings = params['settings'] as Record<string, unknown>;
      // In a real implementation, this would update a database
      return `Settings updated for user ${userId}: ${JSON.stringify(settings)}`;
    },
  });

  // Create an agent that manages user accounts
  const agent = await api.agents.createAgent({
    name: 'user-manager',
    description: 'Manages user accounts and settings',
    systemPrompt: `You are a user management assistant. Help administrators manage user accounts.
    
    You can:
    1. Get user information using get_user_info
    2. Update user settings using update_user_settings
    
    Always verify userIds before making changes.`,
    tools: ['get_user_info', 'update_user_settings'],
    modelConfig: { temp: 0.2 }, // Lower temperature for more consistent responses
    runConfig: { max_turns: 10 }, // Limit the number of turns
  });

  // The agent can now be used to handle user management tasks
  return agent;
}

// Export the examples for use in other modules
export {
  exampleUsingFullAPI,
  exampleUsingUtilityFunctions,
  exampleComplexAgent,
};
