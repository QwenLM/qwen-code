/**
 * Common framework for extending Qwen Code beyond programming use cases
 */

export interface DomainConfig {
  name: string;
  description: string;
  tools: string[];
  workflows: WorkflowDefinition[];
  templates: TemplateDefinition[];
  prompts: DomainPrompts;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  inputs: Record<string, any>;
  outputs: Record<string, any>;
}

export interface WorkflowStep {
  id: string;
  tool: string;
  params: Record<string, any>;
  condition?: string;
  onSuccess?: string;
  onError?: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  content: string;
  variables: TemplateVariable[];
}

export interface TemplateVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  defaultValue?: any;
}

export interface DomainPrompts {
  system: string;
  workflows: Record<string, string>;
  examples: PromptExample[];
}

export interface PromptExample {
  userInput: string;
  expectedFlow: string[];
  description: string;
}

export interface ContentProcessor {
  inputFormats: string[];
  outputFormats: string[];
  process(content: any, options: ProcessingOptions): Promise<ProcessedContent>;
  validate(content: any): ValidationResult;
}

export interface ProcessingOptions {
  format: string;
  quality: 'draft' | 'standard' | 'high';
  customization?: Record<string, any>;
}

export interface ProcessedContent {
  content: any;
  metadata: Record<string, any>;
  quality: QualityMetrics;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  suggestions: string[];
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

export interface QualityMetrics {
  completeness: number; // 0-100
  accuracy: number; // 0-100
  readability: number; // 0-100
  consistency: number; // 0-100
}

export interface AnalyticsEvent {
  domain: string;
  action: string;
  timestamp: Date;
  userId?: string;
  metadata: Record<string, any>;
}

export interface InsightEngine {
  trackEvent(event: AnalyticsEvent): void;
  generateInsights(domain: string, timeframe: TimeRange): Promise<Insight[]>;
  createReport(template: ReportTemplate): Promise<Report>;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface Insight {
  id: string;
  type: 'trend' | 'anomaly' | 'recommendation';
  title: string;
  description: string;
  confidence: number; // 0-100
  actionable: boolean;
  suggestedActions?: string[];
}

export interface ReportTemplate {
  id: string;
  name: string;
  sections: ReportSection[];
  format: 'html' | 'pdf' | 'markdown' | 'json';
}

export interface ReportSection {
  title: string;
  type: 'text' | 'chart' | 'table' | 'image';
  content?: any;
  dataSource?: string;
}

export interface Report {
  id: string;
  title: string;
  generatedAt: Date;
  content: string;
  metadata: Record<string, any>;
}

/**
 * Base class for domain-specific extensions
 */
export abstract class DomainExtension {
  abstract config: DomainConfig;
  abstract contentProcessor: ContentProcessor;
  abstract insightEngine: InsightEngine;

  /**
   * Initialize the domain extension
   */
  abstract initialize(): Promise<void>;

  /**
   * Get available workflows for this domain
   */
  getWorkflows(): WorkflowDefinition[] {
    return this.config.workflows;
  }

  /**
   * Get available templates for this domain
   */
  getTemplates(): TemplateDefinition[] {
    return this.config.templates;
  }

  /**
   * Process domain-specific content
   */
  async processContent(content: any, options: ProcessingOptions): Promise<ProcessedContent> {
    return this.contentProcessor.process(content, options);
  }

  /**
   * Generate insights for this domain
   */
  async generateInsights(timeframe: TimeRange): Promise<Insight[]> {
    return this.insightEngine.generateInsights(this.config.name, timeframe);
  }
}

/**
 * Registry for managing domain extensions
 */
export class ExtensionRegistry {
  private domains = new Map<string, DomainExtension>();

  register(extension: DomainExtension): void {
    this.domains.set(extension.config.name, extension);
  }

  getDomain(name: string): DomainExtension | undefined {
    return this.domains.get(name);
  }

  listDomains(): string[] {
    return Array.from(this.domains.keys());
  }

  async initializeAll(): Promise<void> {
    for (const extension of this.domains.values()) {
      await extension.initialize();
    }
  }
}

/**
 * Workflow execution engine
 */
export class WorkflowEngine {
  constructor(private registry: ExtensionRegistry) {}

  async executeWorkflow(
    domainName: string,
    workflowId: string,
    inputs: Record<string, any>
  ): Promise<WorkflowResult> {
    const domain = this.registry.getDomain(domainName);
    if (!domain) {
      throw new Error(`Domain not found: ${domainName}`);
    }

    const workflow = domain.getWorkflows().find(w => w.id === workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const context = { ...inputs };
    const results: StepResult[] = [];

    for (const step of workflow.steps) {
      try {
        const result = await this.executeStep(step, context);
        results.push(result);
        
        // Update context with step results
        Object.assign(context, result.outputs);
        
        // Handle conditional flow
        if (result.success && step.onSuccess) {
          // Jump to specified step
        } else if (!result.success && step.onError) {
          // Handle error flow
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          completedSteps: results,
          outputs: {}
        };
      }
    }

    return {
      success: true,
      completedSteps: results,
      outputs: context
    };
  }

  private async executeStep(step: WorkflowStep, context: Record<string, any>): Promise<StepResult> {
    // Tool execution logic would be implemented here
    // This is a simplified version
    return {
      stepId: step.id,
      success: true,
      outputs: {},
      duration: 0
    };
  }
}

export interface WorkflowResult {
  success: boolean;
  error?: string;
  completedSteps: StepResult[];
  outputs: Record<string, any>;
}

export interface StepResult {
  stepId: string;
  success: boolean;
  outputs: Record<string, any>;
  duration: number;
  error?: string;
}