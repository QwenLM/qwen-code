/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseTool, ToolResult, Type } from '@qwen-code/qwen-code-core';

/**
 * Base interface for domain-specific contexts
 */
export interface DomainContext {
  userPreferences: Record<string, any>;
  sessionData: Record<string, any>;
  environmentConfig: Record<string, any>;
  domain: string;
}

/**
 * Common content item interface across all domains
 */
export interface ContentItem {
  id: string;
  type: string;
  title: string;
  content: string;
  metadata: Record<string, any>;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Common task interface across all domains
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  dueDate?: Date;
  tags: string[];
  metadata: Record<string, any>;
}

/**
 * User profile interface for personalization
 */
export interface UserProfile {
  preferences: Record<string, any>;
  skills: string[];
  interests: string[];
  goals: string[];
  history: ActivityRecord[];
}

/**
 * Activity record for tracking user interactions
 */
export interface ActivityRecord {
  id: string;
  domain: string;
  action: string;
  timestamp: Date;
  data: Record<string, any>;
}

/**
 * Abstract base class for domain-specific tools
 */
export abstract class DomainTool<TParams = any, TResult = ToolResult> extends BaseTool<TParams, TResult> {
  abstract readonly domain: string;
  abstract readonly category: string;

  constructor(
    name: string,
    displayName: string,
    description: string,
    parameterSchema: any,
    public readonly domainName: string,
    public readonly categoryName: string
  ) {
    super(name, displayName, description, parameterSchema);
  }

  get domain(): string {
    return this.domainName;
  }

  get category(): string {
    return this.categoryName;
  }

  /**
   * Execute the tool with domain context
   */
  abstract executeWithContext(
    params: TParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<TResult>;

  /**
   * Default execute method that creates basic context
   */
  async execute(params: TParams, abortSignal: AbortSignal): Promise<TResult> {
    const context: DomainContext = {
      userPreferences: {},
      sessionData: {},
      environmentConfig: {},
      domain: this.domain
    };
    return this.executeWithContext(params, context, abortSignal);
  }

  /**
   * Get tool usage examples for the LLM
   */
  getUsageExamples(): string[] {
    return [];
  }

  /**
   * Get domain-specific prompt context
   */
  getDomainContext(): string {
    return `This tool operates in the ${this.domain} domain, category: ${this.category}`;
  }
}

/**
 * Abstract base class for domain extensions
 */
export abstract class DomainExtension {
  abstract readonly domain: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly tools: DomainTool[];

  /**
   * Initialize the domain extension
   */
  abstract initialize(): Promise<void>;

  /**
   * Get domain-specific prompt context for the LLM
   */
  abstract getPromptContext(): string;

  /**
   * Get all tools for this domain
   */
  getTools(): DomainTool[] {
    return this.tools;
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: string): DomainTool[] {
    return this.tools.filter(tool => tool.category === category);
  }

  /**
   * Find best tool for a given intent
   */
  findBestTool(intent: string, context?: DomainContext): DomainTool | undefined {
    // Basic implementation - can be enhanced with AI-powered selection
    const keywords = intent.toLowerCase().split(' ');
    
    for (const tool of this.tools) {
      const toolDescription = tool.description.toLowerCase();
      const toolName = tool.name.toLowerCase();
      
      if (keywords.some(keyword => 
        toolDescription.includes(keyword) || toolName.includes(keyword)
      )) {
        return tool;
      }
    }
    
    return undefined;
  }
}

/**
 * Domain registry for managing all domain extensions
 */
export class DomainRegistry {
  private static instance: DomainRegistry;
  private domains: Map<string, DomainExtension> = new Map();

  static getInstance(): DomainRegistry {
    if (!DomainRegistry.instance) {
      DomainRegistry.instance = new DomainRegistry();
    }
    return DomainRegistry.instance;
  }

  /**
   * Register a domain extension
   */
  register(domain: DomainExtension): void {
    this.domains.set(domain.domain, domain);
  }

  /**
   * Get a domain extension by name
   */
  getDomain(name: string): DomainExtension | undefined {
    return this.domains.get(name);
  }

  /**
   * Get all registered domains
   */
  getAllDomains(): DomainExtension[] {
    return Array.from(this.domains.values());
  }

  /**
   * Get all tools across all domains
   */
  getAllTools(): DomainTool[] {
    const allTools: DomainTool[] = [];
    for (const domain of this.domains.values()) {
      allTools.push(...domain.getTools());
    }
    return allTools;
  }

  /**
   * Find best domain and tool for a given intent
   */
  findBestDomainTool(intent: string, context?: DomainContext): { domain: DomainExtension; tool: DomainTool } | undefined {
    for (const domain of this.domains.values()) {
      const tool = domain.findBestTool(intent, context);
      if (tool) {
        return { domain, tool };
      }
    }
    return undefined;
  }

  /**
   * Initialize all registered domains
   */
  async initializeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.domains.values()).map(domain => domain.initialize())
    );
  }
}

/**
 * Smart tool selector using AI-powered intent analysis
 */
export class SmartToolSelector {
  /**
   * Select the best tool based on user intent and context
   */
  selectBestTool(
    userIntent: string,
    availableDomains: string[],
    context: DomainContext
  ): DomainTool[] {
    const registry = DomainRegistry.getInstance();
    const candidates: DomainTool[] = [];

    // Filter domains based on availability
    const domains = registry.getAllDomains()
      .filter(domain => availableDomains.includes(domain.domain));

    // Find candidate tools
    for (const domain of domains) {
      const tool = domain.findBestTool(userIntent, context);
      if (tool) {
        candidates.push(tool);
      }
    }

    // Sort by relevance (basic implementation)
    return candidates.sort((a, b) => {
      const aScore = this.calculateRelevanceScore(userIntent, a);
      const bScore = this.calculateRelevanceScore(userIntent, b);
      return bScore - aScore;
    });
  }

  private calculateRelevanceScore(intent: string, tool: DomainTool): number {
    const intentWords = intent.toLowerCase().split(' ');
    const toolText = `${tool.name} ${tool.description}`.toLowerCase();
    
    let score = 0;
    for (const word of intentWords) {
      if (toolText.includes(word)) {
        score += 1;
      }
    }
    
    return score;
  }
}

/**
 * Data persistence layer for domain-specific data
 */
export interface DomainDataStore {
  save(domain: string, key: string, data: any): Promise<void>;
  load(domain: string, key: string): Promise<any>;
  query(domain: string, filter: any): Promise<any[]>;
  delete(domain: string, key: string): Promise<void>;
  exists(domain: string, key: string): Promise<boolean>;
}

/**
 * In-memory implementation of domain data store
 */
export class InMemoryDomainDataStore implements DomainDataStore {
  private data: Map<string, Map<string, any>> = new Map();

  async save(domain: string, key: string, data: any): Promise<void> {
    if (!this.data.has(domain)) {
      this.data.set(domain, new Map());
    }
    this.data.get(domain)!.set(key, data);
  }

  async load(domain: string, key: string): Promise<any> {
    const domainData = this.data.get(domain);
    return domainData ? domainData.get(key) : undefined;
  }

  async query(domain: string, filter: any): Promise<any[]> {
    const domainData = this.data.get(domain);
    if (!domainData) return [];

    const results: any[] = [];
    for (const [key, value] of domainData.entries()) {
      if (this.matchesFilter(value, filter)) {
        results.push({ key, ...value });
      }
    }
    return results;
  }

  async delete(domain: string, key: string): Promise<void> {
    const domainData = this.data.get(domain);
    if (domainData) {
      domainData.delete(key);
    }
  }

  async exists(domain: string, key: string): Promise<boolean> {
    const domainData = this.data.get(domain);
    return domainData ? domainData.has(key) : false;
  }

  private matchesFilter(item: any, filter: any): boolean {
    // Simple filter matching - can be enhanced
    for (const [key, value] of Object.entries(filter)) {
      if (item[key] !== value) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Context builder for creating domain-specific contexts
 */
export class DomainContextBuilder {
  private context: Partial<DomainContext> = {};

  setDomain(domain: string): this {
    this.context.domain = domain;
    return this;
  }

  setUserPreferences(preferences: Record<string, any>): this {
    this.context.userPreferences = preferences;
    return this;
  }

  setSessionData(sessionData: Record<string, any>): this {
    this.context.sessionData = sessionData;
    return this;
  }

  setEnvironmentConfig(config: Record<string, any>): this {
    this.context.environmentConfig = config;
    return this;
  }

  build(): DomainContext {
    return {
      userPreferences: this.context.userPreferences || {},
      sessionData: this.context.sessionData || {},
      environmentConfig: this.context.environmentConfig || {},
      domain: this.context.domain || 'unknown'
    };
  }
}

/**
 * Utility functions for domain extensions
 */
export class DomainUtils {
  /**
   * Generate a unique ID for domain items
   */
  static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create a standard content item
   */
  static createContentItem(
    type: string,
    title: string,
    content: string,
    metadata: Record<string, any> = {},
    tags: string[] = []
  ): ContentItem {
    const now = new Date();
    return {
      id: this.generateId(),
      type,
      title,
      content,
      metadata,
      tags,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Create a standard task
   */
  static createTask(
    title: string,
    description: string,
    priority: Task['priority'] = 'medium',
    metadata: Record<string, any> = {},
    tags: string[] = []
  ): Task {
    return {
      id: this.generateId(),
      title,
      description,
      status: 'pending',
      priority,
      tags,
      metadata
    };
  }

  /**
   * Validate and sanitize user input
   */
  static sanitizeInput(input: string): string {
    return input.trim().replace(/[<>]/g, '');
  }

  /**
   * Format content for display
   */
  static formatForDisplay(content: string, maxLength: number = 500): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '...';
  }
}