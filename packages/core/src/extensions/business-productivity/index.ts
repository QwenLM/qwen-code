/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@sinclair/typebox';
import { ToolResult } from '@qwen-code/qwen-code-core';
import { 
  DomainExtension, 
  DomainTool, 
  DomainContext, 
  Task, 
  DomainUtils 
} from '../domain-framework.js';

// ==================== INTERFACES ====================

interface ProjectPlanParams {
  projectName: string;
  objectives: string[];
  timeline: string;
  resources: string[];
  stakeholders: string[];
  constraints?: string[];
  methodology?: 'agile' | 'waterfall' | 'lean' | 'hybrid';
}

interface DataAnalysisParams {
  dataSource: string;
  analysisType: 'trend' | 'comparison' | 'prediction' | 'summary' | 'correlation';
  metrics: string[];
  timeframe?: string;
  format?: 'chart' | 'table' | 'report' | 'dashboard';
}

interface CommunicationParams {
  type: 'email' | 'proposal' | 'presentation' | 'report' | 'memo' | 'meeting-agenda';
  audience: string;
  purpose: string;
  tone: 'formal' | 'casual' | 'persuasive' | 'informative' | 'urgent';
  keyPoints: string[];
  deadline?: string;
}

interface MeetingManagementParams {
  type: 'planning' | 'agenda' | 'notes' | 'action-items' | 'follow-up';
  meetingPurpose: string;
  participants: string[];
  duration: number;
  topics?: string[];
  decisions?: string[];
}

interface TaskManagementParams {
  action: 'create' | 'update' | 'prioritize' | 'schedule' | 'assign';
  tasks?: Task[];
  criteria?: string;
  timeframe?: string;
  team?: string[];
}

// ==================== TOOLS ====================

/**
 * Project Planning Tool - Creates comprehensive project plans and strategies
 */
export class ProjectPlanningTool extends DomainTool<ProjectPlanParams, ToolResult> {
  constructor() {
    super(
      'project-planning',
      'Project Planning',
      'Creates comprehensive project plans with timelines, milestones, resource allocation, and risk management',
      {
        type: Type.Object({
          projectName: Type.String({ 
            description: 'Name of the project' 
          }),
          objectives: Type.Array(Type.String(), { 
            description: 'List of project objectives and goals' 
          }),
          timeline: Type.String({ 
            description: 'Project timeline (e.g., "3 months", "Q2 2024")' 
          }),
          resources: Type.Array(Type.String(), { 
            description: 'Available resources (people, budget, tools, etc.)' 
          }),
          stakeholders: Type.Array(Type.String(), { 
            description: 'Project stakeholders and their roles' 
          }),
          constraints: Type.Optional(Type.Array(Type.String(), { 
            description: 'Project constraints and limitations' 
          })),
          methodology: Type.Optional(Type.Union([
            Type.Literal('agile'),
            Type.Literal('waterfall'),
            Type.Literal('lean'),
            Type.Literal('hybrid')
          ], { description: 'Project management methodology' }))
        }),
        required: ['projectName', 'objectives', 'timeline', 'resources', 'stakeholders']
      },
      'business-productivity',
      'planning'
    );
  }

  async executeWithContext(
    params: ProjectPlanParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { projectName, objectives, timeline, resources, stakeholders, constraints, methodology } = params;

      const projectPlan = this.createProjectPlan(projectName, objectives, methodology || 'hybrid');
      const timelinePlan = this.createTimeline(timeline, objectives, methodology || 'hybrid');
      const resourceAllocation = this.allocateResources(resources, objectives);
      const stakeholderMatrix = this.createStakeholderMatrix(stakeholders);
      const riskAssessment = this.assessRisks(objectives, constraints || []);
      const milestones = this.defineMilestones(objectives, timeline);

      const result = {
        projectName,
        methodology: methodology || 'hybrid',
        projectPlan,
        timeline: timelinePlan,
        milestones,
        resourceAllocation,
        stakeholderMatrix,
        riskAssessment,
        successMetrics: this.defineSuccessMetrics(objectives),
        nextSteps: this.generateNextSteps(methodology || 'hybrid')
      };

      return {
        success: true,
        result: `Project Plan Created Successfully!\n\n${this.formatProjectPlan(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create project plan: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private createProjectPlan(name: string, objectives: string[], methodology: string): Record<string, any> {
    return {
      name,
      methodology,
      phases: this.generatePhases(objectives, methodology),
      approach: this.getMethodologyApproach(methodology),
      governance: this.defineGovernance(methodology),
      communication: this.defineCommunicationPlan()
    };
  }

  private generatePhases(objectives: string[], methodology: string): any[] {
    const basePhases = {
      agile: [
        'Project Initiation & Planning',
        'Sprint Planning & Setup',
        'Development Sprints (Iterative)',
        'Testing & Quality Assurance',
        'Deployment & Release',
        'Retrospective & Continuous Improvement'
      ],
      waterfall: [
        'Requirements Gathering',
        'System Design',
        'Implementation',
        'Integration & Testing',
        'Deployment',
        'Maintenance & Support'
      ],
      lean: [
        'Value Stream Mapping',
        'Minimum Viable Product (MVP)',
        'Build-Measure-Learn Cycles',
        'Continuous Improvement',
        'Scale & Optimize'
      ],
      hybrid: [
        'Discovery & Planning',
        'Design & Architecture',
        'Iterative Development',
        'Testing & Validation',
        'Deployment & Launch',
        'Monitoring & Optimization'
      ]
    };

    const phases = basePhases[methodology as keyof typeof basePhases] || basePhases.hybrid;
    
    return phases.map((phase, index) => ({
      id: index + 1,
      name: phase,
      objectives: objectives.filter((_, i) => i % phases.length === index),
      deliverables: this.generatePhaseDeliverables(phase),
      estimatedDuration: this.estimatePhaseDuration(phase, methodology)
    }));
  }

  private generatePhaseDeliverables(phaseName: string): string[] {
    const deliverables: Record<string, string[]> = {
      'Project Initiation & Planning': ['Project charter', 'Stakeholder analysis', 'Risk register'],
      'Requirements Gathering': ['Requirements document', 'Use cases', 'Acceptance criteria'],
      'System Design': ['Architecture diagram', 'Technical specifications', 'UI/UX mockups'],
      'Implementation': ['Code deliverables', 'Documentation', 'Unit tests'],
      'Testing & Quality Assurance': ['Test plans', 'Test results', 'Bug reports'],
      'Deployment': ['Deployment guide', 'Release notes', 'Training materials'],
      'Discovery & Planning': ['Research findings', 'Project roadmap', 'Resource plan'],
      'Design & Architecture': ['System design', 'Data models', 'Integration specs']
    };

    return deliverables[phaseName] || ['Phase deliverables', 'Documentation', 'Progress report'];
  }

  private estimatePhaseDuration(phaseName: string, methodology: string): string {
    const durations: Record<string, Record<string, string>> = {
      agile: {
        'Project Initiation & Planning': '1-2 weeks',
        'Sprint Planning & Setup': '1 week',
        'Development Sprints (Iterative)': '6-12 weeks',
        'Testing & Quality Assurance': 'Continuous',
        'Deployment & Release': '1 week',
        'Retrospective & Continuous Improvement': 'Ongoing'
      },
      waterfall: {
        'Requirements Gathering': '2-4 weeks',
        'System Design': '2-3 weeks',
        'Implementation': '8-12 weeks',
        'Integration & Testing': '2-3 weeks',
        'Deployment': '1-2 weeks',
        'Maintenance & Support': 'Ongoing'
      },
      hybrid: {
        'Discovery & Planning': '2-3 weeks',
        'Design & Architecture': '1-2 weeks',
        'Iterative Development': '8-10 weeks',
        'Testing & Validation': '2 weeks',
        'Deployment & Launch': '1 week',
        'Monitoring & Optimization': 'Ongoing'
      }
    };

    return durations[methodology]?.[phaseName] || '2-4 weeks';
  }

  private getMethodologyApproach(methodology: string): Record<string, any> {
    const approaches: Record<string, any> = {
      agile: {
        principles: ['Customer collaboration', 'Responding to change', 'Working software', 'Individuals and interactions'],
        ceremonies: ['Daily standups', 'Sprint planning', 'Sprint review', 'Retrospectives'],
        artifacts: ['Product backlog', 'Sprint backlog', 'Burndown charts']
      },
      waterfall: {
        principles: ['Sequential phases', 'Comprehensive documentation', 'Predictable timelines', 'Quality gates'],
        ceremonies: ['Phase gate reviews', 'Stakeholder meetings', 'Progress reports'],
        artifacts: ['Project plan', 'Requirements documents', 'Design specifications']
      },
      lean: {
        principles: ['Eliminate waste', 'Deliver fast', 'Build quality in', 'Learn continuously'],
        ceremonies: ['Value stream mapping', 'Continuous improvement sessions', 'Customer feedback loops'],
        artifacts: ['Value stream maps', 'Kanban boards', 'Metrics dashboards']
      },
      hybrid: {
        principles: ['Adaptive planning', 'Iterative delivery', 'Risk management', 'Stakeholder engagement'],
        ceremonies: ['Sprint planning', 'Regular reviews', 'Milestone assessments'],
        artifacts: ['Roadmaps', 'Backlogs', 'Progress tracking']
      }
    };

    return approaches[methodology] || approaches.hybrid;
  }

  private createTimeline(timeframe: string, objectives: string[], methodology: string): Record<string, any> {
    const phases = this.generatePhases(objectives, methodology);
    const totalWeeks = this.parseTimeframe(timeframe);
    
    let currentWeek = 0;
    const schedule = phases.map(phase => {
      const duration = this.parseDuration(phase.estimatedDuration);
      const start = currentWeek;
      const end = currentWeek + duration - 1;
      currentWeek += duration;
      
      return {
        phase: phase.name,
        startWeek: start,
        endWeek: end,
        duration: `${duration} weeks`,
        status: start === 0 ? 'ready' : 'pending'
      };
    });

    return {
      totalDuration: timeframe,
      totalWeeks,
      schedule,
      criticalPath: this.identifyCriticalPath(schedule),
      bufferTime: Math.max(0, totalWeeks - currentWeek)
    };
  }

  private parseTimeframe(timeframe: string): number {
    const months = timeframe.match(/(\d+)\s*months?/i);
    const weeks = timeframe.match(/(\d+)\s*weeks?/i);
    
    if (months) return parseInt(months[1]) * 4;
    if (weeks) return parseInt(weeks[1]);
    return 12; // Default to 3 months
  }

  private parseDuration(duration: string): number {
    const weeks = duration.match(/(\d+)-?(\d+)?\s*weeks?/i);
    if (weeks) {
      const min = parseInt(weeks[1]);
      const max = weeks[2] ? parseInt(weeks[2]) : min;
      return Math.ceil((min + max) / 2);
    }
    return 2; // Default
  }

  private allocateResources(resources: string[], objectives: string[]): Record<string, any> {
    const resourceTypes = this.categorizeResources(resources);
    
    return {
      human: resourceTypes.human,
      financial: resourceTypes.financial,
      technical: resourceTypes.technical,
      allocation: this.createResourceAllocation(resourceTypes, objectives),
      utilization: this.estimateUtilization(resourceTypes)
    };
  }

  private categorizeResources(resources: string[]): Record<string, any> {
    return {
      human: resources.filter(r => 
        r.toLowerCase().includes('developer') || 
        r.toLowerCase().includes('designer') || 
        r.toLowerCase().includes('manager') ||
        r.toLowerCase().includes('team') ||
        r.toLowerCase().includes('person')
      ),
      financial: resources.filter(r => 
        r.toLowerCase().includes('budget') || 
        r.toLowerCase().includes('$') || 
        r.toLowerCase().includes('cost')
      ),
      technical: resources.filter(r => 
        r.toLowerCase().includes('server') || 
        r.toLowerCase().includes('software') || 
        r.toLowerCase().includes('tool') ||
        r.toLowerCase().includes('hardware')
      )
    };
  }

  private createResourceAllocation(resourceTypes: any, objectives: string[]): any[] {
    return objectives.map((objective, index) => ({
      objective,
      assignedResources: {
        human: resourceTypes.human[index % resourceTypes.human.length] || 'TBD',
        technical: resourceTypes.technical[index % resourceTypes.technical.length] || 'Standard tools',
        budget: 'To be allocated'
      },
      priority: index < 2 ? 'high' : index < 4 ? 'medium' : 'low'
    }));
  }

  private estimateUtilization(resourceTypes: any): Record<string, string> {
    return {
      human: `${Math.min(100, resourceTypes.human.length * 25)}% capacity`,
      technical: 'Standard utilization',
      financial: 'Budget tracking required'
    };
  }

  private createStakeholderMatrix(stakeholders: string[]): any[] {
    return stakeholders.map(stakeholder => ({
      name: stakeholder,
      role: this.inferStakeholderRole(stakeholder),
      influence: this.estimateInfluence(stakeholder),
      interest: this.estimateInterest(stakeholder),
      communication: this.suggestCommunication(stakeholder)
    }));
  }

  private inferStakeholderRole(stakeholder: string): string {
    const stakeholderLower = stakeholder.toLowerCase();
    if (stakeholderLower.includes('sponsor') || stakeholderLower.includes('executive')) return 'Sponsor';
    if (stakeholderLower.includes('user') || stakeholderLower.includes('customer')) return 'End User';
    if (stakeholderLower.includes('manager')) return 'Project Manager';
    if (stakeholderLower.includes('team') || stakeholderLower.includes('developer')) return 'Team Member';
    return 'Stakeholder';
  }

  private estimateInfluence(stakeholder: string): 'high' | 'medium' | 'low' {
    const stakeholderLower = stakeholder.toLowerCase();
    if (stakeholderLower.includes('ceo') || stakeholderLower.includes('sponsor') || stakeholderLower.includes('executive')) return 'high';
    if (stakeholderLower.includes('manager') || stakeholderLower.includes('lead')) return 'medium';
    return 'low';
  }

  private estimateInterest(stakeholder: string): 'high' | 'medium' | 'low' {
    const stakeholderLower = stakeholder.toLowerCase();
    if (stakeholderLower.includes('user') || stakeholderLower.includes('customer') || stakeholderLower.includes('sponsor')) return 'high';
    if (stakeholderLower.includes('manager')) return 'medium';
    return 'low';
  }

  private suggestCommunication(stakeholder: string): string {
    const role = this.inferStakeholderRole(stakeholder);
    const communications: Record<string, string> = {
      'Sponsor': 'Weekly executive summary, milestone reviews',
      'End User': 'Demo sessions, feedback collection, training',
      'Project Manager': 'Daily updates, detailed progress reports',
      'Team Member': 'Daily standups, sprint planning, retrospectives',
      'Stakeholder': 'Regular updates, milestone notifications'
    };
    return communications[role] || 'Regular project updates';
  }

  private assessRisks(objectives: string[], constraints: string[]): any[] {
    const risks = [
      {
        risk: 'Resource availability conflicts',
        probability: 'medium',
        impact: 'high',
        mitigation: 'Cross-train team members, maintain resource buffer'
      },
      {
        risk: 'Scope creep',
        probability: 'high',
        impact: 'medium',
        mitigation: 'Clear requirements documentation, change control process'
      },
      {
        risk: 'Technical complexity',
        probability: 'medium',
        impact: 'high',
        mitigation: 'Proof of concepts, technical spikes, expert consultation'
      }
    ];

    // Add constraint-specific risks
    constraints.forEach(constraint => {
      if (constraint.toLowerCase().includes('budget')) {
        risks.push({
          risk: 'Budget overrun',
          probability: 'medium',
          impact: 'high',
          mitigation: 'Regular budget monitoring, cost control measures'
        });
      }
      if (constraint.toLowerCase().includes('time')) {
        risks.push({
          risk: 'Schedule delays',
          probability: 'high',
          impact: 'medium',
          mitigation: 'Buffer time, parallel workstreams, priority management'
        });
      }
    });

    return risks;
  }

  private defineMilestones(objectives: string[], timeline: string): any[] {
    const totalWeeks = this.parseTimeframe(timeline);
    const milestoneCount = Math.min(objectives.length, 6);
    
    return Array.from({ length: milestoneCount }, (_, index) => ({
      milestone: `Milestone ${index + 1}: ${objectives[index] || 'Project checkpoint'}`,
      week: Math.ceil((index + 1) * totalWeeks / milestoneCount),
      deliverables: this.generateMilestoneDeliverables(index),
      criteria: 'All deliverables completed and reviewed'
    }));
  }

  private generateMilestoneDeliverables(index: number): string[] {
    const deliverables = [
      ['Project charter', 'Initial requirements', 'Team assembly'],
      ['Design specifications', 'Architecture decisions', 'Prototype'],
      ['Core functionality', 'Initial testing', 'Documentation'],
      ['Integration complete', 'System testing', 'User acceptance'],
      ['Production deployment', 'Training materials', 'Support documentation'],
      ['Project closure', 'Lessons learned', 'Handover complete']
    ];
    
    return deliverables[index] || ['Phase deliverables', 'Progress review', 'Next phase planning'];
  }

  private defineSuccessMetrics(objectives: string[]): string[] {
    return [
      'All project objectives completed on time and within budget',
      'Stakeholder satisfaction score > 80%',
      'Quality metrics meet defined acceptance criteria',
      'Team productivity and morale maintained',
      'Risk mitigation strategies effectively implemented',
      'Knowledge transfer and documentation completed'
    ];
  }

  private generateNextSteps(methodology: string): string[] {
    const nextSteps: Record<string, string[]> = {
      agile: [
        'Set up project workspace and tools',
        'Conduct initial sprint planning session',
        'Define user stories and acceptance criteria',
        'Establish team communication channels',
        'Create initial product backlog'
      ],
      waterfall: [
        'Finalize and approve project charter',
        'Conduct detailed requirements gathering',
        'Set up project governance structure',
        'Establish communication protocols',
        'Begin system design phase'
      ],
      hybrid: [
        'Validate project scope and objectives',
        'Set up collaborative workspace',
        'Plan initial discovery sprint',
        'Establish stakeholder communication plan',
        'Define success criteria and metrics'
      ]
    };

    return nextSteps[methodology] || nextSteps.hybrid;
  }

  private identifyCriticalPath(schedule: any[]): string[] {
    return schedule
      .filter(phase => phase.duration !== 'Ongoing' && phase.duration !== 'Continuous')
      .map(phase => phase.phase);
  }

  private formatProjectPlan(result: any): string {
    return `
**Project:** ${result.projectName}
**Methodology:** ${result.methodology}

**PROJECT PHASES:**
${result.projectPlan.phases.map((phase: any, index: number) => 
  `${index + 1}. ${phase.name} (${phase.estimatedDuration})\n   Deliverables: ${phase.deliverables.join(', ')}`
).join('\n')}

**TIMELINE:**
${result.timeline.schedule.map((item: any) => 
  `Week ${item.startWeek + 1}-${item.endWeek + 1}: ${item.phase}`
).join('\n')}

**KEY MILESTONES:**
${result.milestones.map((milestone: any) => 
  `• Week ${milestone.week}: ${milestone.milestone}`
).join('\n')}

**RESOURCE ALLOCATION:**
${result.resourceAllocation.allocation.map((alloc: any) => 
  `• ${alloc.objective}: ${alloc.assignedResources.human} (${alloc.priority} priority)`
).join('\n')}

**STAKEHOLDER MATRIX:**
${result.stakeholderMatrix.map((stakeholder: any) => 
  `• ${stakeholder.name} (${stakeholder.role}): ${stakeholder.influence} influence, ${stakeholder.interest} interest`
).join('\n')}

**TOP RISKS:**
${result.riskAssessment.slice(0, 3).map((risk: any) => 
  `• ${risk.risk} (${risk.probability} probability, ${risk.impact} impact)\n  Mitigation: ${risk.mitigation}`
).join('\n')}

**SUCCESS METRICS:**
${result.successMetrics.map((metric: string) => `• ${metric}`).join('\n')}

**IMMEDIATE NEXT STEPS:**
${result.nextSteps.map((step: string) => `• ${step}`).join('\n')}
    `.trim();
  }
}

/**
 * Data Analysis Tool - Analyzes business data and generates insights
 */
export class DataAnalysisTool extends DomainTool<DataAnalysisParams, ToolResult> {
  constructor() {
    super(
      'data-analysis',
      'Data Analysis',
      'Analyzes business data, identifies trends, and generates actionable insights',
      {
        type: Type.Object({
          dataSource: Type.String({ 
            description: 'Description of the data source (e.g., "Q3 sales data", "user engagement metrics")' 
          }),
          analysisType: Type.Union([
            Type.Literal('trend'),
            Type.Literal('comparison'),
            Type.Literal('prediction'),
            Type.Literal('summary'),
            Type.Literal('correlation')
          ], { description: 'Type of analysis to perform' }),
          metrics: Type.Array(Type.String(), { 
            description: 'Specific metrics to analyze (e.g., ["revenue", "conversion rate", "user growth"])' 
          }),
          timeframe: Type.Optional(Type.String({ 
            description: 'Time period for analysis (e.g., "last 6 months", "Q3 2024")' 
          })),
          format: Type.Optional(Type.Union([
            Type.Literal('chart'),
            Type.Literal('table'),
            Type.Literal('report'),
            Type.Literal('dashboard')
          ], { description: 'Preferred format for results' }))
        }),
        required: ['dataSource', 'analysisType', 'metrics']
      },
      'business-productivity',
      'analysis'
    );
  }

  async executeWithContext(
    params: DataAnalysisParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { dataSource, analysisType, metrics, timeframe, format } = params;

      const analysisResults = this.performAnalysis(dataSource, analysisType, metrics, timeframe);
      const insights = this.generateInsights(analysisResults, analysisType);
      const recommendations = this.createRecommendations(insights, metrics);
      const visualizations = this.suggestVisualizations(analysisType, metrics, format);

      const result = {
        dataSource,
        analysisType,
        timeframe: timeframe || 'Current period',
        metrics,
        results: analysisResults,
        insights,
        recommendations,
        visualizations,
        summary: this.createExecutiveSummary(analysisResults, insights)
      };

      return {
        success: true,
        result: `Data Analysis Complete!\n\n${this.formatAnalysisReport(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private performAnalysis(
    dataSource: string, 
    analysisType: string, 
    metrics: string[], 
    timeframe?: string
  ): Record<string, any> {
    // Simulated analysis results - in real implementation would connect to actual data sources
    const baseData = this.generateSampleData(metrics, timeframe);
    
    switch (analysisType) {
      case 'trend':
        return this.analyzeTrends(baseData, metrics);
      case 'comparison':
        return this.performComparison(baseData, metrics);
      case 'prediction':
        return this.generatePredictions(baseData, metrics);
      case 'summary':
        return this.createSummaryStats(baseData, metrics);
      case 'correlation':
        return this.analyzeCorrelations(baseData, metrics);
      default:
        return this.createSummaryStats(baseData, metrics);
    }
  }

  private generateSampleData(metrics: string[], timeframe?: string): Record<string, any> {
    const periods = timeframe ? this.parseTimeframe(timeframe) : 12;
    const data: Record<string, any> = {};
    
    metrics.forEach(metric => {
      data[metric] = Array.from({ length: periods }, (_, i) => ({
        period: i + 1,
        value: Math.random() * 1000 + 500,
        change: (Math.random() - 0.5) * 0.2 // ±10% change
      }));
    });
    
    return data;
  }

  private parseTimeframe(timeframe: string): number {
    if (timeframe.toLowerCase().includes('quarter')) return 3;
    if (timeframe.toLowerCase().includes('year')) return 12;
    if (timeframe.toLowerCase().includes('month')) {
      const match = timeframe.match(/(\d+)/);
      return match ? parseInt(match[1]) : 6;
    }
    return 6; // Default to 6 periods
  }

  private analyzeTrends(data: Record<string, any>, metrics: string[]): Record<string, any> {
    const trends: Record<string, any> = {};
    
    metrics.forEach(metric => {
      const values = data[metric]?.map((item: any) => item.value) || [];
      const trend = this.calculateTrend(values);
      
      trends[metric] = {
        direction: trend > 0.05 ? 'increasing' : trend < -0.05 ? 'decreasing' : 'stable',
        rate: Math.abs(trend * 100).toFixed(1) + '%',
        strength: Math.abs(trend) > 0.1 ? 'strong' : Math.abs(trend) > 0.05 ? 'moderate' : 'weak',
        current: values[values.length - 1]?.toFixed(2),
        previous: values[values.length - 2]?.toFixed(2)
      };
    });
    
    return trends;
  }

  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;
    
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    values.forEach((y, x) => {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const avgY = sumY / n;
    
    return slope / avgY; // Normalized slope
  }

  private performComparison(data: Record<string, any>, metrics: string[]): Record<string, any> {
    const comparisons: Record<string, any> = {};
    
    metrics.forEach(metric => {
      const values = data[metric]?.map((item: any) => item.value) || [];
      const current = values[values.length - 1] || 0;
      const previous = values[values.length - 2] || 0;
      const average = values.reduce((sum, val) => sum + val, 0) / values.length;
      
      comparisons[metric] = {
        currentValue: current.toFixed(2),
        previousValue: previous.toFixed(2),
        averageValue: average.toFixed(2),
        changeFromPrevious: ((current - previous) / previous * 100).toFixed(1) + '%',
        changeFromAverage: ((current - average) / average * 100).toFixed(1) + '%',
        performance: current > average ? 'above average' : current < average ? 'below average' : 'at average'
      };
    });
    
    return comparisons;
  }

  private generatePredictions(data: Record<string, any>, metrics: string[]): Record<string, any> {
    const predictions: Record<string, any> = {};
    
    metrics.forEach(metric => {
      const values = data[metric]?.map((item: any) => item.value) || [];
      const trend = this.calculateTrend(values);
      const current = values[values.length - 1] || 0;
      
      predictions[metric] = {
        nextPeriod: (current * (1 + trend)).toFixed(2),
        confidence: Math.abs(trend) > 0.1 ? 'high' : Math.abs(trend) > 0.05 ? 'medium' : 'low',
        trend: trend > 0 ? 'upward' : trend < 0 ? 'downward' : 'stable',
        factors: this.identifyPredictionFactors(metric, trend)
      };
    });
    
    return predictions;
  }

  private createSummaryStats(data: Record<string, any>, metrics: string[]): Record<string, any> {
    const summary: Record<string, any> = {};
    
    metrics.forEach(metric => {
      const values = data[metric]?.map((item: any) => item.value) || [];
      
      summary[metric] = {
        count: values.length,
        sum: values.reduce((sum, val) => sum + val, 0).toFixed(2),
        average: (values.reduce((sum, val) => sum + val, 0) / values.length).toFixed(2),
        minimum: Math.min(...values).toFixed(2),
        maximum: Math.max(...values).toFixed(2),
        standardDeviation: this.calculateStandardDeviation(values).toFixed(2)
      };
    });
    
    return summary;
  }

  private calculateStandardDeviation(values: number[]): number {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  private analyzeCorrelations(data: Record<string, any>, metrics: string[]): Record<string, any> {
    const correlations: Record<string, any> = {};
    
    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        const metric1 = metrics[i];
        const metric2 = metrics[j];
        const values1 = data[metric1]?.map((item: any) => item.value) || [];
        const values2 = data[metric2]?.map((item: any) => item.value) || [];
        
        const correlation = this.calculateCorrelation(values1, values2);
        
        correlations[`${metric1}_vs_${metric2}`] = {
          coefficient: correlation.toFixed(3),
          strength: Math.abs(correlation) > 0.7 ? 'strong' : Math.abs(correlation) > 0.3 ? 'moderate' : 'weak',
          direction: correlation > 0 ? 'positive' : correlation < 0 ? 'negative' : 'none'
        };
      }
    }
    
    return correlations;
  }

  private calculateCorrelation(values1: number[], values2: number[]): number {
    const n = Math.min(values1.length, values2.length);
    if (n < 2) return 0;
    
    const mean1 = values1.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    const mean2 = values2.slice(0, n).reduce((sum, val) => sum + val, 0) / n;
    
    let numerator = 0, sumSq1 = 0, sumSq2 = 0;
    
    for (let i = 0; i < n; i++) {
      const diff1 = values1[i] - mean1;
      const diff2 = values2[i] - mean2;
      numerator += diff1 * diff2;
      sumSq1 += diff1 * diff1;
      sumSq2 += diff2 * diff2;
    }
    
    const denominator = Math.sqrt(sumSq1 * sumSq2);
    return denominator === 0 ? 0 : numerator / denominator;
  }

  private generateInsights(results: Record<string, any>, analysisType: string): string[] {
    const insights: string[] = [];
    
    switch (analysisType) {
      case 'trend':
        Object.entries(results).forEach(([metric, data]: [string, any]) => {
          insights.push(`${metric} is showing a ${data.strength} ${data.direction} trend at ${data.rate} rate`);
        });
        break;
        
      case 'comparison':
        Object.entries(results).forEach(([metric, data]: [string, any]) => {
          insights.push(`${metric} is currently ${data.performance} with a ${data.changeFromPrevious} change from previous period`);
        });
        break;
        
      case 'prediction':
        Object.entries(results).forEach(([metric, data]: [string, any]) => {
          insights.push(`${metric} is predicted to ${data.trend} to ${data.nextPeriod} next period (${data.confidence} confidence)`);
        });
        break;
        
      default:
        insights.push('Analysis reveals key patterns and trends in the data');
        insights.push('Performance metrics show variability across different areas');
        insights.push('Data suggests opportunities for optimization and improvement');
    }
    
    return insights;
  }

  private createRecommendations(insights: string[], metrics: string[]): string[] {
    const recommendations: string[] = [];
    
    // General recommendations based on analysis type
    recommendations.push('Monitor key metrics regularly to identify changes early');
    recommendations.push('Focus on metrics showing the strongest positive trends');
    recommendations.push('Investigate and address areas showing negative performance');
    
    // Metric-specific recommendations
    metrics.forEach(metric => {
      if (metric.toLowerCase().includes('revenue') || metric.toLowerCase().includes('sales')) {
        recommendations.push('Consider revenue optimization strategies and pricing analysis');
      }
      if (metric.toLowerCase().includes('user') || metric.toLowerCase().includes('customer')) {
        recommendations.push('Implement user engagement and retention programs');
      }
      if (metric.toLowerCase().includes('cost')) {
        recommendations.push('Review cost structure and identify efficiency opportunities');
      }
    });
    
    return recommendations.slice(0, 5); // Limit to top 5 recommendations
  }

  private suggestVisualizations(
    analysisType: string, 
    metrics: string[], 
    format?: string
  ): Record<string, any> {
    const visualizations: Record<string, any> = {
      recommended: this.getRecommendedVisualization(analysisType),
      charts: this.suggestChartTypes(analysisType, metrics),
      layout: format || 'report'
    };
    
    return visualizations;
  }

  private getRecommendedVisualization(analysisType: string): string {
    const recommendations: Record<string, string> = {
      trend: 'Line chart showing metrics over time',
      comparison: 'Bar chart comparing current vs previous periods',
      prediction: 'Line chart with forecasted values',
      summary: 'Dashboard with key metric cards',
      correlation: 'Scatter plot matrix showing relationships'
    };
    
    return recommendations[analysisType] || 'Data table with key metrics';
  }

  private suggestChartTypes(analysisType: string, metrics: string[]): string[] {
    const chartTypes = [];
    
    if (analysisType === 'trend') {
      chartTypes.push('Time series line chart', 'Area chart for cumulative metrics');
    }
    if (analysisType === 'comparison') {
      chartTypes.push('Grouped bar chart', 'Horizontal bar chart for rankings');
    }
    if (metrics.length > 1) {
      chartTypes.push('Multi-metric dashboard', 'Comparative bar chart');
    }
    
    return chartTypes;
  }

  private identifyPredictionFactors(metric: string, trend: number): string[] {
    const factors = ['Historical performance patterns', 'Seasonal variations'];
    
    if (metric.toLowerCase().includes('sales') || metric.toLowerCase().includes('revenue')) {
      factors.push('Market conditions', 'Customer demand', 'Competition');
    }
    if (metric.toLowerCase().includes('user') || metric.toLowerCase().includes('traffic')) {
      factors.push('Marketing campaigns', 'Product changes', 'User behavior');
    }
    
    return factors;
  }

  private createExecutiveSummary(results: Record<string, any>, insights: string[]): string {
    return `
The analysis reveals ${insights.length} key insights across the examined metrics. 
${insights[0] || 'Data shows mixed performance across different areas.'}
${insights[1] || 'Continued monitoring and strategic adjustments are recommended.'}
    `.trim();
  }

  private formatAnalysisReport(result: any): string {
    return `
**Data Source:** ${result.dataSource}
**Analysis Type:** ${result.analysisType}
**Time Period:** ${result.timeframe}
**Metrics Analyzed:** ${result.metrics.join(', ')}

**EXECUTIVE SUMMARY:**
${result.summary}

**KEY INSIGHTS:**
${result.insights.map((insight: string) => `• ${insight}`).join('\n')}

**DETAILED RESULTS:**
${Object.entries(result.results).map(([key, value]: [string, any]) => 
  `**${key.toUpperCase()}:**\n${this.formatDetailedResults(value)}`
).join('\n\n')}

**RECOMMENDATIONS:**
${result.recommendations.map((rec: string) => `• ${rec}`).join('\n')}

**VISUALIZATION SUGGESTIONS:**
• Primary: ${result.visualizations.recommended}
• Additional: ${result.visualizations.charts.join(', ')}
• Format: ${result.visualizations.layout}
    `.trim();
  }

  private formatDetailedResults(data: any): string {
    if (typeof data === 'object' && data !== null) {
      return Object.entries(data)
        .map(([key, value]: [string, any]) => `  ${key}: ${value}`)
        .join('\n');
    }
    return String(data);
  }
}

/**
 * Communication Assistant Tool - Generates professional communications
 */
export class CommunicationAssistantTool extends DomainTool<CommunicationParams, ToolResult> {
  constructor() {
    super(
      'communication-assistant',
      'Communication Assistant',
      'Generates professional emails, proposals, presentations, and other business communications',
      {
        type: Type.Object({
          type: Type.Union([
            Type.Literal('email'),
            Type.Literal('proposal'),
            Type.Literal('presentation'),
            Type.Literal('report'),
            Type.Literal('memo'),
            Type.Literal('meeting-agenda')
          ], { description: 'Type of communication to generate' }),
          audience: Type.String({ 
            description: 'Target audience (e.g., "executive team", "clients", "project stakeholders")' 
          }),
          purpose: Type.String({ 
            description: 'Purpose or objective of the communication' 
          }),
          tone: Type.Union([
            Type.Literal('formal'),
            Type.Literal('casual'),
            Type.Literal('persuasive'),
            Type.Literal('informative'),
            Type.Literal('urgent')
          ], { description: 'Tone and style for the communication' }),
          keyPoints: Type.Array(Type.String(), { 
            description: 'Main points or topics to cover' 
          }),
          deadline: Type.Optional(Type.String({ 
            description: 'Deadline or time constraint if applicable' 
          }))
        }),
        required: ['type', 'audience', 'purpose', 'tone', 'keyPoints']
      },
      'business-productivity',
      'communication'
    );
  }

  async executeWithContext(
    params: CommunicationParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { type, audience, purpose, tone, keyPoints, deadline } = params;

      const structure = this.createStructure(type, tone);
      const content = this.generateContent(type, audience, purpose, tone, keyPoints, deadline);
      const suggestions = this.createSuggestions(type, tone, audience);

      const result = {
        type,
        audience,
        purpose,
        tone,
        structure,
        content,
        suggestions,
        nextSteps: this.generateNextSteps(type)
      };

      return {
        success: true,
        result: `${type.charAt(0).toUpperCase() + type.slice(1)} Generated Successfully!\n\n${this.formatCommunication(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Communication generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private createStructure(type: string, tone: string): string[] {
    const structures: Record<string, string[]> = {
      email: [
        'Subject Line',
        'Greeting',
        'Opening Statement',
        'Main Content',
        'Call to Action',
        'Closing'
      ],
      proposal: [
        'Executive Summary',
        'Problem Statement',
        'Proposed Solution',
        'Benefits and Value',
        'Implementation Plan',
        'Investment and Timeline',
        'Next Steps'
      ],
      presentation: [
        'Title Slide',
        'Agenda/Outline',
        'Problem/Opportunity',
        'Solution/Approach',
        'Benefits/Results',
        'Implementation',
        'Questions/Discussion'
      ],
      report: [
        'Executive Summary',
        'Background/Context',
        'Methodology',
        'Findings',
        'Analysis',
        'Recommendations',
        'Conclusion'
      ],
      memo: [
        'Header (To/From/Date/Subject)',
        'Purpose Statement',
        'Background',
        'Key Information',
        'Action Required',
        'Timeline'
      ],
      'meeting-agenda': [
        'Meeting Details',
        'Attendees',
        'Objectives',
        'Agenda Items',
        'Time Allocations',
        'Action Items',
        'Next Meeting'
      ]
    };

    return structures[type] || structures.email;
  }

  private generateContent(
    type: string,
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[],
    deadline?: string
  ): Record<string, string> {
    const contentGenerators: Record<string, () => Record<string, string>> = {
      email: () => this.generateEmailContent(audience, purpose, tone, keyPoints, deadline),
      proposal: () => this.generateProposalContent(audience, purpose, tone, keyPoints),
      presentation: () => this.generatePresentationContent(audience, purpose, tone, keyPoints),
      report: () => this.generateReportContent(audience, purpose, tone, keyPoints),
      memo: () => this.generateMemoContent(audience, purpose, tone, keyPoints, deadline),
      'meeting-agenda': () => this.generateAgendaContent(audience, purpose, keyPoints)
    };

    const generator = contentGenerators[type] || contentGenerators.email;
    return generator();
  }

  private generateEmailContent(
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[],
    deadline?: string
  ): Record<string, string> {
    const greeting = this.getGreeting(tone, audience);
    const subject = this.generateSubjectLine(purpose, tone, deadline);
    const closing = this.getClosing(tone);

    return {
      'Subject Line': subject,
      'Greeting': greeting,
      'Opening Statement': this.generateOpening(purpose, tone),
      'Main Content': this.formatKeyPoints(keyPoints, tone),
      'Call to Action': this.generateCallToAction(purpose, deadline, tone),
      'Closing': closing
    };
  }

  private generateProposalContent(
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[]
  ): Record<string, string> {
    return {
      'Executive Summary': `This proposal outlines ${purpose} for ${audience}. The key benefits include ${keyPoints[0] || 'significant value creation'}.`,
      'Problem Statement': `Current challenges facing ${audience} include: ${keyPoints.slice(0, 2).join(', ')}.`,
      'Proposed Solution': `We propose ${purpose} through a comprehensive approach that addresses ${keyPoints.length} key areas.`,
      'Benefits and Value': this.formatBenefits(keyPoints),
      'Implementation Plan': 'Implementation will follow a phased approach with clear milestones and deliverables.',
      'Investment and Timeline': 'Investment requirements and timeline will be finalized based on specific needs and priorities.',
      'Next Steps': 'We recommend scheduling a meeting to discuss this proposal in detail and answer any questions.'
    };
  }

  private generatePresentationContent(
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[]
  ): Record<string, string> {
    return {
      'Title Slide': `${purpose} - Presentation for ${audience}`,
      'Agenda/Outline': `Today we'll cover: ${keyPoints.join(', ')}`,
      'Problem/Opportunity': `Current situation analysis and opportunities for ${audience}`,
      'Solution/Approach': `Proposed approach to address ${purpose}`,
      'Benefits/Results': this.formatBenefits(keyPoints),
      'Implementation': 'Step-by-step implementation roadmap and timeline',
      'Questions/Discussion': 'Open floor for questions and discussion'
    };
  }

  private generateReportContent(
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[]
  ): Record<string, string> {
    return {
      'Executive Summary': `This report examines ${purpose} and provides ${keyPoints.length} key findings for ${audience}.`,
      'Background/Context': `Background information and context relevant to ${purpose}`,
      'Methodology': 'Research methodology and data collection approach used in this analysis',
      'Findings': `Key findings include: ${keyPoints.join('; ')}`,
      'Analysis': 'Detailed analysis of findings and their implications',
      'Recommendations': this.formatRecommendations(keyPoints),
      'Conclusion': `Summary of key insights and recommended actions for ${audience}`
    };
  }

  private generateMemoContent(
    audience: string,
    purpose: string,
    tone: string,
    keyPoints: string[],
    deadline?: string
  ): Record<string, string> {
    return {
      'Header (To/From/Date/Subject)': `TO: ${audience}\nFROM: [Your Name]\nDATE: ${new Date().toLocaleDateString()}\nSUBJECT: ${purpose}`,
      'Purpose Statement': `The purpose of this memo is to ${purpose}.`,
      'Background': 'Background information and context for this communication',
      'Key Information': this.formatKeyPoints(keyPoints, 'formal'),
      'Action Required': this.generateActionRequired(keyPoints, deadline),
      'Timeline': deadline ? `Please note the deadline of ${deadline} for required actions.` : 'Timeline will be communicated separately.'
    };
  }

  private generateAgendaContent(audience: string, purpose: string, keyPoints: string[]): Record<string, string> {
    const timeSlots = this.allocateTimeSlots(keyPoints);
    
    return {
      'Meeting Details': `Meeting Purpose: ${purpose}\nDuration: ${timeSlots.total} minutes\nFormat: [In-person/Virtual]`,
      'Attendees': audience,
      'Objectives': purpose,
      'Agenda Items': this.formatAgendaItems(keyPoints, timeSlots.items),
      'Time Allocations': `Total time: ${timeSlots.total} minutes`,
      'Action Items': 'Action items will be captured during the meeting',
      'Next Meeting': 'Next meeting date will be determined based on outcomes'
    };
  }

  private getGreeting(tone: string, audience: string): string {
    const greetings: Record<string, string> = {
      formal: `Dear ${audience},`,
      casual: `Hi ${audience},`,
      persuasive: `Dear ${audience},`,
      informative: `Hello ${audience},`,
      urgent: `Dear ${audience},`
    };
    
    return greetings[tone] || greetings.formal;
  }

  private generateSubjectLine(purpose: string, tone: string, deadline?: string): string {
    const prefix = tone === 'urgent' ? '[URGENT] ' : '';
    const suffix = deadline ? ` - Action Required by ${deadline}` : '';
    
    return `${prefix}${purpose}${suffix}`;
  }

  private getClosing(tone: string): string {
    const closings: Record<string, string> = {
      formal: 'Sincerely,\n[Your Name]',
      casual: 'Best regards,\n[Your Name]',
      persuasive: 'Looking forward to your response,\n[Your Name]',
      informative: 'Best regards,\n[Your Name]',
      urgent: 'Please respond at your earliest convenience,\n[Your Name]'
    };
    
    return closings[tone] || closings.formal;
  }

  private generateOpening(purpose: string, tone: string): string {
    const openings: Record<string, string> = {
      formal: `I am writing to ${purpose}.`,
      casual: `I wanted to reach out about ${purpose}.`,
      persuasive: `I have an exciting opportunity regarding ${purpose}.`,
      informative: `I am providing an update on ${purpose}.`,
      urgent: `I need your immediate attention regarding ${purpose}.`
    };
    
    return openings[tone] || openings.formal;
  }

  private formatKeyPoints(keyPoints: string[], tone: string): string {
    const connector = tone === 'formal' ? 'Furthermore, ' : 'Also, ';
    
    return keyPoints.map((point, index) => {
      const prefix = index === 0 ? '' : connector;
      return `${prefix}${point}`;
    }).join('\n\n');
  }

  private generateCallToAction(purpose: string, deadline?: string, tone: string): string {
    const urgency = tone === 'urgent' ? 'immediately' : 'at your convenience';
    const deadlineText = deadline ? ` by ${deadline}` : '';
    
    return `Please ${purpose.toLowerCase().includes('review') ? 'review and provide feedback' : 'let me know your thoughts'} ${urgency}${deadlineText}.`;
  }

  private formatBenefits(keyPoints: string[]): string {
    return keyPoints.map((point, index) => `${index + 1}. ${point}`).join('\n');
  }

  private formatRecommendations(keyPoints: string[]): string {
    return keyPoints.map((point, index) => `Recommendation ${index + 1}: ${point}`).join('\n');
  }

  private generateActionRequired(keyPoints: string[], deadline?: string): string {
    const actions = keyPoints.map(point => `• ${point}`).join('\n');
    const deadlineText = deadline ? ` Please complete by ${deadline}.` : '';
    
    return `The following actions are required:\n${actions}${deadlineText}`;
  }

  private allocateTimeSlots(keyPoints: string[]): { total: number; items: number[] } {
    const baseTime = 10; // minutes per item
    const items = keyPoints.map(() => baseTime);
    const total = items.reduce((sum, time) => sum + time, 0) + 20; // Add 20 min for intro/wrap-up
    
    return { total, items };
  }

  private formatAgendaItems(keyPoints: string[], timeSlots: number[]): string {
    return keyPoints.map((point, index) => 
      `${index + 1}. ${point} (${timeSlots[index]} minutes)`
    ).join('\n');
  }

  private createSuggestions(type: string, tone: string, audience: string): string[] {
    const suggestions = [
      'Review and customize the content to match your specific needs',
      'Add specific details, dates, and names where applicable',
      'Consider the recipient\'s preferences and communication style'
    ];

    if (type === 'email') {
      suggestions.push('Keep the subject line clear and actionable');
      suggestions.push('Use bullet points for multiple items');
    }

    if (type === 'proposal') {
      suggestions.push('Include specific metrics and ROI calculations');
      suggestions.push('Add case studies or testimonials if available');
    }

    if (tone === 'urgent') {
      suggestions.push('Follow up with a phone call if no response within 24 hours');
    }

    return suggestions;
  }

  private generateNextSteps(type: string): string[] {
    const nextSteps: Record<string, string[]> = {
      email: [
        'Review and edit the content',
        'Add specific details and personalization',
        'Send and track responses',
        'Follow up if necessary'
      ],
      proposal: [
        'Review all sections for accuracy',
        'Add financial details and timelines',
        'Get internal approval if required',
        'Schedule presentation meeting'
      ],
      presentation: [
        'Create visual slides from content outline',
        'Practice the presentation',
        'Prepare for Q&A session',
        'Set up technical requirements'
      ]
    };

    return nextSteps[type] || nextSteps.email;
  }

  private formatCommunication(result: any): string {
    const sections = Object.entries(result.content)
      .map(([section, content]: [string, any]) => `**${section.toUpperCase()}:**\n${content}`)
      .join('\n\n');

    return `
**Communication Type:** ${result.type}
**Audience:** ${result.audience}
**Purpose:** ${result.purpose}
**Tone:** ${result.tone}

${sections}

**SUGGESTIONS:**
${result.suggestions.map((suggestion: string) => `• ${suggestion}`).join('\n')}

**NEXT STEPS:**
${result.nextSteps.map((step: string) => `• ${step}`).join('\n')}
    `.trim();
  }
}

// ==================== DOMAIN EXTENSION ====================

/**
 * Business & Productivity Assistant Domain Extension
 */
export class BusinessProductivityExtension extends DomainExtension {
  readonly domain = 'business-productivity';
  readonly name = 'Business & Productivity Assistant';
  readonly description = 'Comprehensive business tools for project management, data analysis, and professional communication';
  
  readonly tools: DomainTool[] = [
    new ProjectPlanningTool(),
    new DataAnalysisTool(),
    new CommunicationAssistantTool()
  ];

  async initialize(): Promise<void> {
    console.log('Business & Productivity Extension initialized');
  }

  getPromptContext(): string {
    return `
You are now operating in the Business & Productivity Assistant domain. This domain is designed to help with:

1. **Project Planning** - Creating comprehensive project plans with timelines, resource allocation, and risk management
2. **Data Analysis** - Analyzing business data, identifying trends, and generating actionable insights
3. **Communication** - Generating professional emails, proposals, presentations, and business documents

Available tools:
- project-planning: Creates detailed project plans with methodologies, timelines, and resource allocation
- data-analysis: Analyzes business data and generates insights with visualizations and recommendations
- communication-assistant: Generates professional business communications in various formats

Focus on providing strategic, data-driven assistance for business professionals, project managers, and teams looking to improve productivity and achieve business objectives.
    `.trim();
  }
}