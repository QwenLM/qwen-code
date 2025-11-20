/* eslint-env node */

/* global console */

import { BuiltinAgentRegistry } from './src/subagents/builtin-agents.js';

console.log(
  'Available built-in agents:',
  BuiltinAgentRegistry.getBuiltinAgentNames(),
);

// Check if our agent is in the registry
const agentNames = BuiltinAgentRegistry.getBuiltinAgentNames();
const hasDeepWebSearch = agentNames.includes('deep-web-search');
console.log('Deep web search agent registered:', hasDeepWebSearch);

// Get the agent details
const deepWebSearchAgent =
  BuiltinAgentRegistry.getBuiltinAgent('deep-web-search');
console.log('Deep web search agent found:', !!deepWebSearchAgent);

if (deepWebSearchAgent) {
  console.log('Agent name:', deepWebSearchAgent.name);
  console.log(
    'Agent description (first 100 chars):',
    deepWebSearchAgent.description.substring(0, 100) + '...',
  );
  console.log('Available tools:', deepWebSearchAgent.tools || 'default tools');
}

// Also test that it's not just the name but the full config
console.log('All builtin agents count:', agentNames.length);
console.log(
  'Expected agents: general-purpose, project-manager, deep-web-search',
);
