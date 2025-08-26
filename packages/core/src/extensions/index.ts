/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { DomainRegistry } from './domain-framework.js';

// Import all domain extensions
import { ContentCreationExtension } from './content-creation/index.js';
import { BusinessProductivityExtension } from './business-productivity/index.js';
import { EducationalLearningExtension } from './educational-learning/index.js';
import { CreativeDesignExtension } from './creative-design/index.js';
import { PersonalAssistantExtension } from './personal-assistant/index.js';

/**
 * Initialize and register all domain extensions
 */
export async function initializeDomainExtensions(): Promise<void> {
  const registry = DomainRegistry.getInstance();
  
  // Register all domain extensions
  registry.register(new ContentCreationExtension());
  registry.register(new BusinessProductivityExtension());
  registry.register(new EducationalLearningExtension());
  registry.register(new CreativeDesignExtension());
  registry.register(new PersonalAssistantExtension());
  
  // Initialize all domains
  await registry.initializeAll();
  
  console.log('All domain extensions initialized successfully');
}

/**
 * Get enhanced system prompt with domain context
 */
export function getEnhancedSystemPrompt(): string {
  const registry = DomainRegistry.getInstance();
  const domains = registry.getAllDomains();
  
  const domainDescriptions = domains.map(domain => 
    `**${domain.name} (${domain.domain})**: ${domain.description}`
  ).join('\n');
  
  const allTools = registry.getAllTools();
  const toolDescriptions = allTools.map(tool => 
    `- **${tool.name}** (${tool.domain}): ${tool.description}`
  ).join('\n');
  
  return `
# Qwen Code: Enhanced Multi-Domain Assistant

You now have access to **${domains.length} specialized domains** with **${allTools.length} powerful tools** for non-programming tasks:

## Available Domains:

${domainDescriptions}

## All Available Tools:

${toolDescriptions}

## Usage Guidelines:

1. **Domain Detection**: Automatically identify which domain best fits the user's request
2. **Tool Selection**: Choose the most appropriate tool(s) for the task
3. **Context Awareness**: Consider user preferences and previous interactions
4. **Multi-Domain Integration**: Combine tools from different domains when beneficial
5. **Professional Output**: Deliver high-quality, actionable results

## Example Usage Patterns:

**Content Creation:**
- "Create a blog post strategy for our tech startup"
- "Research AI trends and write a comprehensive report"
- "Optimize this article for SEO and engagement"

**Business & Productivity:**
- "Create a project plan for our mobile app launch"
- "Analyze our Q3 sales data and identify opportunities"
- "Draft a proposal for implementing new CRM system"

**Educational & Learning:**
- "Design a JavaScript curriculum for beginners"
- "Create interactive exercises for machine learning concepts"
- "Develop a personalized study plan for AWS certification"

**Creative & Design:**
- "Generate brand identity concepts for sustainable fashion startup"
- "Brainstorm marketing campaign ideas for fitness app"
- "Develop comprehensive brand strategy for tech consulting"

**Personal Assistant:**
- "Create a life plan for achieving marathon goal in 6 months"
- "Design health and wellness routine for busy professional"
- "Develop financial planning strategy for house purchase"

Always provide comprehensive, professional assistance that leverages the full capabilities of these specialized domains.
  `.trim();
}

/**
 * Export all domain extensions and framework components
 */
export * from './domain-framework.js';
export * from './content-creation/index.js';
export * from './business-productivity/index.js';
export * from './educational-learning/index.js';
export * from './creative-design/index.js';
export * from './personal-assistant/index.js';