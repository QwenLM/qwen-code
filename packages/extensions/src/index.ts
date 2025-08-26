/**
 * Qwen Code Extensions Package
 * Multi-domain AI assistant platform
 */

// Framework exports
export * from './framework/base.js';

// Domain extensions
export { EducationalExtension } from './domains/education/index.js';
export { ContentCreationExtension } from './domains/content/index.js';
export { BusinessProcessExtension } from './domains/business/index.js';
export { CreativeWritingExtension } from './domains/creative/index.js';
export { DataAnalysisExtension } from './domains/research/index.js';

// Main registry and initialization
import { ExtensionRegistry, WorkflowEngine } from './framework/base.js';
import { EducationalExtension } from './domains/education/index.js';
import { ContentCreationExtension } from './domains/content/index.js';
import { BusinessProcessExtension } from './domains/business/index.js';
import { CreativeWritingExtension } from './domains/creative/index.js';
import { DataAnalysisExtension } from './domains/research/index.js';

/**
 * Initialize all domain extensions
 */
export async function initializeExtensions(): Promise<ExtensionRegistry> {
  const registry = new ExtensionRegistry();
  
  // Register all domain extensions
  registry.register(new EducationalExtension());
  registry.register(new ContentCreationExtension());
  registry.register(new BusinessProcessExtension());
  registry.register(new CreativeWritingExtension());
  registry.register(new DataAnalysisExtension());
  
  // Initialize all extensions
  await registry.initializeAll();
  
  return registry;
}

/**
 * Create workflow engine with extensions
 */
export function createWorkflowEngine(registry: ExtensionRegistry): WorkflowEngine {
  return new WorkflowEngine(registry);
}

/**
 * Domain configuration presets
 */
export const DomainPresets = {
  education: {
    name: 'education',
    enabled: true,
    settings: {
      defaultLevel: 'university',
      learningStyle: 'mixed',
      adaptiveDifficulty: true,
      progressTracking: true
    }
  },
  content: {
    name: 'content-creation',
    enabled: true,
    settings: {
      defaultFormat: 'markdown',
      seoOptimization: true,
      brandConsistency: true,
      multiplatformPublishing: true
    }
  },
  business: {
    name: 'business-process',
    enabled: true,
    settings: {
      complianceChecking: true,
      automationRecommendations: true,
      performanceMonitoring: true,
      processOptimization: true
    }
  },
  creative: {
    name: 'creative-writing',
    enabled: true,
    settings: {
      characterDevelopment: true,
      plotStructuring: true,
      styleAnalysis: true,
      genreAdaptation: true
    }
  },
  research: {
    name: 'data-analysis',
    enabled: true,
    settings: {
      statisticalRigor: true,
      reproducibility: true,
      visualizationGeneration: true,
      researchEthics: true
    }
  }
};

/**
 * Utility function to get domain by name
 */
export function getDomainExtension(registry: ExtensionRegistry, domainName: string) {
  return registry.getDomain(domainName);
}

/**
 * Utility function to list all available domains
 */
export function listAvailableDomains(registry: ExtensionRegistry): string[] {
  return registry.listDomains();
}

/**
 * Extension metadata for CLI integration
 */
export const ExtensionMetadata = {
  version: '0.1.0',
  author: 'Qwen Code Team',
  description: 'Multi-domain extensions for Qwen Code AI assistant',
  domains: [
    {
      name: 'education',
      description: 'Intelligent tutoring and educational content creation',
      icon: '🎓',
      keywords: ['learning', 'teaching', 'education', 'tutoring', 'quiz']
    },
    {
      name: 'content-creation',
      description: 'Documentation and content automation platform',
      icon: '📝',
      keywords: ['documentation', 'content', 'writing', 'seo', 'publishing']
    },
    {
      name: 'business-process',
      description: 'Business process optimization and automation',
      icon: '⚙️',
      keywords: ['process', 'workflow', 'automation', 'business', 'optimization']
    },
    {
      name: 'creative-writing',
      description: 'Creative writing and storytelling assistance',
      icon: '✍️',
      keywords: ['writing', 'story', 'creative', 'character', 'plot']
    },
    {
      name: 'data-analysis',
      description: 'Data analysis and research assistance',
      icon: '📊',
      keywords: ['data', 'analysis', 'research', 'statistics', 'insights']
    }
  ]
};

export default {
  initializeExtensions,
  createWorkflowEngine,
  getDomainExtension,
  listAvailableDomains,
  DomainPresets,
  ExtensionMetadata
};