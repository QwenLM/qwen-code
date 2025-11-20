/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { AgentSharedMemory } from './shared-memory.js';

export interface AgentMetrics {
  agentName: string;
  timestamp: string;
  tasksCompleted: number;
  tasksFailed: number;
  avgResponseTime: number; // in ms
  totalProcessingTime: number; // in ms
  collaborationCount: number; // Number of successful collaborations with other agents
  errors: string[];
}

export interface CollaborationMetrics {
  timestamp: string;
  workflowId?: string;
  initiatingAgent: string;
  receivingAgent: string;
  messageType: string;
  duration: number; // in ms
  success: boolean;
  error?: string;
}

export interface SystemMetrics {
  timestamp: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  avgTaskCompletionTime: number; // in ms
  activeAgents: number;
  avgAgentLoad: number;
  memoryUsage: number; // in bytes
  avgMessageResponseTime: number; // in ms
}

export interface PerformanceReport {
  systemMetrics: SystemMetrics;
  agentMetrics: AgentMetrics[];
  collaborationMetrics: CollaborationMetrics[];
  periodStart: string;
  periodEnd: string;
}

/**
 * Metrics collection system for monitoring agent collaboration performance
 */
export class AgentMetricsCollector {
  private memory: AgentSharedMemory;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.memory = new AgentSharedMemory(config);

    // Use config to prevent unused variable error
    void this.config;
  }

  /**
   * Record metrics for an agent's task completion
   */
  async recordAgentTaskMetrics(
    agentName: string,
    success: boolean,
    responseTime: number,
    processingTime: number,
  ): Promise<void> {
    const currentMetrics = await this.getAgentMetrics(agentName);

    if (success) {
      currentMetrics.tasksCompleted += 1;
    } else {
      currentMetrics.tasksFailed += 1;
    }

    currentMetrics.avgResponseTime =
      (currentMetrics.avgResponseTime *
        (currentMetrics.tasksCompleted + currentMetrics.tasksFailed - 1) +
        responseTime) /
      (currentMetrics.tasksCompleted + currentMetrics.tasksFailed);

    currentMetrics.totalProcessingTime += processingTime;

    await this.setAgentMetrics(agentName, currentMetrics);
  }

  /**
   * Record metrics for agent collaboration
   */
  async recordCollaborationMetrics(
    workflowId: string | undefined,
    initiatingAgent: string,
    receivingAgent: string,
    messageType: string,
    duration: number,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const collaborationMetrics: CollaborationMetrics = {
      timestamp: new Date().toISOString(),
      workflowId,
      initiatingAgent,
      receivingAgent,
      messageType,
      duration,
      success,
      error,
    };

    // Store in shared memory
    const key = `collaboration-metrics:${Date.now()}`;
    await this.memory.set(key, collaborationMetrics);

    // Update agent's collaboration count if successful
    if (success) {
      const agentMetrics = await this.getAgentMetrics(initiatingAgent);
      agentMetrics.collaborationCount += 1;
      await this.setAgentMetrics(initiatingAgent, agentMetrics);
    }
  }

  /**
   * Record system-level metrics
   */
  async recordSystemMetrics(
    metrics: Omit<SystemMetrics, 'timestamp'>,
  ): Promise<void> {
    const systemMetrics: SystemMetrics = {
      ...metrics,
      timestamp: new Date().toISOString(),
    };

    // Store in shared memory
    const key = `system-metrics:${Date.now()}`;
    await this.memory.set(key, systemMetrics);
  }

  /**
   * Get metrics for a specific agent
   */
  async getAgentMetrics(agentName: string): Promise<AgentMetrics> {
    const key = `agent-metrics:${agentName}`;
    let metrics = await this.memory.get<AgentMetrics>(key);

    if (!metrics) {
      // Initialize metrics for this agent
      metrics = {
        agentName,
        timestamp: new Date().toISOString(),
        tasksCompleted: 0,
        tasksFailed: 0,
        avgResponseTime: 0,
        totalProcessingTime: 0,
        collaborationCount: 0,
        errors: [],
      };
    }

    return metrics;
  }

  /**
   * Set metrics for a specific agent
   */
  async setAgentMetrics(
    agentName: string,
    metrics: AgentMetrics,
  ): Promise<void> {
    const key = `agent-metrics:${agentName}`;
    await this.memory.set(key, metrics);
  }

  /**
   * Get recent collaboration metrics (last N entries)
   */
  async getRecentCollaborationMetrics(
    count: number = 50,
  ): Promise<CollaborationMetrics[]> {
    const keys = await this.memory.keys();
    const collaborationKeys = keys
      .filter((key) => key.startsWith('collaboration-metrics:'))
      .sort() // Sort chronologically
      .slice(-count); // Get last N entries

    const metrics: CollaborationMetrics[] = [];
    for (const key of collaborationKeys) {
      const metric = await this.memory.get<CollaborationMetrics>(key);
      if (metric) {
        metrics.push(metric);
      }
    }

    return metrics;
  }

  /**
   * Get recent system metrics (last N entries)
   */
  async getRecentSystemMetrics(count: number = 20): Promise<SystemMetrics[]> {
    const keys = await this.memory.keys();
    const systemKeys = keys
      .filter((key) => key.startsWith('system-metrics:'))
      .sort() // Sort chronologically
      .slice(-count); // Get last N entries

    const metrics: SystemMetrics[] = [];
    for (const key of systemKeys) {
      const metric = await this.memory.get<SystemMetrics>(key);
      if (metric) {
        metrics.push(metric);
      }
    }

    return metrics;
  }

  /**
   * Generate a performance report for a specific time period
   */
  async generatePerformanceReport(
    periodStart: string,
    periodEnd: string = new Date().toISOString(),
  ): Promise<PerformanceReport> {
    // Get all agent metrics
    const agentKeys = await this.memory.keys();
    const agentMetricKeys = agentKeys.filter((key) =>
      key.startsWith('agent-metrics:'),
    );

    const agentMetrics: AgentMetrics[] = [];
    for (const key of agentMetricKeys) {
      const metric = await this.memory.get<AgentMetrics>(key);
      if (metric) {
        agentMetrics.push(metric);
      }
    }

    // Get collaboration metrics within the time period
    const allCollaborationMetrics =
      await this.getRecentCollaborationMetrics(1000); // Get more than we need
    const filteredCollaborationMetrics = allCollaborationMetrics.filter(
      (metric) =>
        metric.timestamp >= periodStart && metric.timestamp <= periodEnd,
    );

    // Get system metrics within the time period
    const allSystemMetrics = await this.getRecentSystemMetrics(100);
    const filteredSystemMetrics = allSystemMetrics.filter(
      (metric) =>
        metric.timestamp >= periodStart && metric.timestamp <= periodEnd,
    );

    // Calculate aggregate system metrics
    let totalTasks = 0;
    let completedTasks = 0;
    let failedTasks = 0;
    let avgTaskCompletionTime = 0;
    let avgMessageResponseTime = 0;

    if (filteredSystemMetrics.length > 0) {
      const lastMetrics =
        filteredSystemMetrics[filteredSystemMetrics.length - 1];
      totalTasks = lastMetrics.totalTasks;
      completedTasks = lastMetrics.completedTasks;
      failedTasks = lastMetrics.failedTasks;
      avgTaskCompletionTime = lastMetrics.avgTaskCompletionTime;
      avgMessageResponseTime = lastMetrics.avgMessageResponseTime;
    }

    const systemMetrics: SystemMetrics = {
      timestamp: new Date().toISOString(),
      totalTasks,
      completedTasks,
      failedTasks,
      avgTaskCompletionTime,
      activeAgents: agentMetrics.length,
      avgAgentLoad:
        agentMetrics.reduce(
          (sum, agent) => sum + (agent.tasksCompleted + agent.tasksFailed),
          0,
        ) / agentMetrics.length || 0,
      memoryUsage: (await this.memory.getStats()).size,
      avgMessageResponseTime,
      periodStart,
      periodEnd,
    } as SystemMetrics & { periodStart: string; periodEnd: string };

    return {
      systemMetrics,
      agentMetrics,
      collaborationMetrics: filteredCollaborationMetrics,
      periodStart,
      periodEnd,
    };
  }

  /**
   * Get the shared memory instance for direct access
   */
  getMemory(): AgentSharedMemory {
    return this.memory;
  }
}
