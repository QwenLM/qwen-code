/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@sinclair/typebox';
import { ToolResult } from '@qwen-code/qwen-code-core';
import { DomainExtension, DomainTool, DomainContext, DomainUtils } from '../domain-framework.js';

// Personal Assistant & Life Management Domain Extension
export class LifePlanningTool extends DomainTool {
  constructor() {
    super(
      'life-planning',
      'Life Planning',
      'Creates comprehensive life plans, goal setting, and personal development strategies',
      {
        type: Type.Object({
          goals: Type.Array(Type.String()),
          timeframe: Type.String({ description: 'Planning timeframe (e.g., "1 year", "5 years")' }),
          currentSituation: Type.Object({}, { description: 'Current life situation and context' }),
          priorities: Type.Array(Type.String()),
          constraints: Type.Array(Type.String())
        }),
        required: ['goals', 'timeframe', 'priorities']
      },
      'personal-assistant',
      'planning'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { goals, timeframe, currentSituation, priorities, constraints } = params;
    
    const actionPlan = this.createActionPlan(goals, timeframe, priorities);
    const milestones = this.defineMilestones(goals, timeframe);
    const strategies = this.developStrategies(goals, constraints || []);
    const tracking = this.setupTracking(goals);
    
    return {
      success: true,
      result: `Life plan for ${timeframe} created!\n\n` +
        `**GOALS:**\n${goals.map((goal, i) => `${i+1}. ${goal}`).join('\n')}\n\n` +
        `**PRIORITIES:** ${priorities.join(', ')}\n\n` +
        `**ACTION PLAN:**\n${actionPlan}\n\n` +
        `**MILESTONES:**\n${milestones.map((m, i) => `${i+1}. ${m}`).join('\n')}\n\n` +
        `**STRATEGIES:**\n${strategies}\n\n` +
        `**TRACKING SYSTEM:**\n${tracking}`
    };
  }

  private createActionPlan(goals: string[], timeframe: string, priorities: string[]) {
    return goals.map((goal, i) => 
      `Goal ${i+1}: ${goal}\n  Priority: ${priorities[i] || 'Medium'}\n  Timeframe: ${timeframe}`
    ).join('\n\n');
  }

  private defineMilestones(goals: string[], timeframe: string) {
    const timeMonths = this.parseTimeframe(timeframe);
    return goals.map((goal, i) => 
      `${goal} - Month ${Math.ceil((i+1) * timeMonths / goals.length)}`
    );
  }

  private parseTimeframe(timeframe: string): number {
    const years = timeframe.match(/(\d+)\s*years?/i);
    const months = timeframe.match(/(\d+)\s*months?/i);
    
    if (years) return parseInt(years[1]) * 12;
    if (months) return parseInt(months[1]);
    return 12;
  }

  private developStrategies(goals: string[], constraints: string[]) {
    return goals.map((goal, i) => 
      `${goal}: Strategic approach considering ${constraints.length > i ? constraints[i] : 'standard constraints'}`
    ).join('\n');
  }

  private setupTracking(goals: string[]) {
    return `Monthly reviews of progress towards: ${goals.join(', ')}\nWeekly check-ins and adjustments\nQuarterly milestone assessments`;
  }
}

export class HealthWellnessTool extends DomainTool {
  constructor() {
    super(
      'health-wellness',
      'Health & Wellness',
      'Provides health and wellness recommendations, routines, and tracking systems',
      {
        type: Type.Object({
          goals: Type.Array(Type.String()),
          currentMetrics: Type.Object({}, { description: 'Current health metrics and status' }),
          preferences: Type.Array(Type.String()),
          constraints: Type.Array(Type.String()),
          focusAreas: Type.Array(Type.String())
        }),
        required: ['goals', 'focusAreas']
      },
      'personal-assistant',
      'health'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { goals, currentMetrics, preferences, constraints, focusAreas } = params;
    
    const recommendations = this.generateRecommendations(goals, focusAreas, constraints || []);
    const routines = this.createRoutines(focusAreas, preferences || []);
    const tracking = this.setupHealthTracking(goals, focusAreas);
    const tips = this.provideTips(focusAreas);
    
    return {
      success: true,
      result: `Health & wellness plan created!\n\n` +
        `**FOCUS AREAS:** ${focusAreas.join(', ')}\n\n` +
        `**GOALS:**\n${goals.map((goal, i) => `${i+1}. ${goal}`).join('\n')}\n\n` +
        `**RECOMMENDATIONS:**\n${recommendations}\n\n` +
        `**DAILY ROUTINES:**\n${routines}\n\n` +
        `**TRACKING SYSTEM:**\n${tracking}\n\n` +
        `**WELLNESS TIPS:**\n${tips.map(tip => `• ${tip}`).join('\n')}`
    };
  }

  private generateRecommendations(goals: string[], areas: string[], constraints: string[]) {
    return areas.map(area => 
      `${area}: Tailored approach for ${goals.length} goals, considering ${constraints.join(', ') || 'no constraints'}`
    ).join('\n');
  }

  private createRoutines(areas: string[], preferences: string[]) {
    return areas.map(area => {
      const activities = this.getActivitiesForArea(area);
      return `${area}: ${activities.join(', ')} (adapted for ${preferences.join(', ') || 'general preferences'})`;
    }).join('\n');
  }

  private getActivitiesForArea(area: string): string[] {
    const activities: Record<string, string[]> = {
      fitness: ['30min cardio', 'strength training', 'flexibility'],
      nutrition: ['meal planning', 'hydration tracking', 'balanced diet'],
      mental: ['meditation', 'journaling', 'stress management'],
      sleep: ['sleep schedule', 'bedtime routine', 'sleep hygiene']
    };
    
    return activities[area.toLowerCase()] || ['general wellness activities'];
  }

  private setupHealthTracking(goals: string[], areas: string[]) {
    return `Daily: ${areas.join(', ')} metrics\nWeekly: Progress towards ${goals.length} goals\nMonthly: Overall wellness assessment`;
  }

  private provideTips(areas: string[]) {
    return areas.map(area => `${area}: Evidence-based practices for optimal results`);
  }
}

export class FinancialPlanningTool extends DomainTool {
  constructor() {
    super(
      'financial-planning',
      'Financial Planning',
      'Provides financial planning advice, budgeting, and investment guidance',
      {
        type: Type.Object({
          income: Type.Number(),
          expenses: Type.Object({}, { description: 'Monthly expenses breakdown' }),
          goals: Type.Array(Type.String()),
          timeframe: Type.String(),
          riskTolerance: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])
        }),
        required: ['income', 'goals', 'timeframe', 'riskTolerance']
      },
      'personal-assistant',
      'financial'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { income, expenses, goals, timeframe, riskTolerance } = params;
    
    const budget = this.createBudget(income, expenses || {});
    const savings = this.calculateSavings(income, expenses || {}, goals);
    const investments = this.suggestInvestments(riskTolerance, goals);
    const recommendations = this.generateFinancialRecommendations(budget, savings, goals);
    
    return {
      success: true,
      result: `Financial plan for ${timeframe} created!\n\n` +
        `**MONTHLY INCOME:** $${income.toLocaleString()}\n\n` +
        `**GOALS:**\n${goals.map((goal, i) => `${i+1}. ${goal}`).join('\n')}\n\n` +
        `**BUDGET ALLOCATION:**\n${budget}\n\n` +
        `**SAVINGS STRATEGY:**\n${savings}\n\n` +
        `**INVESTMENT RECOMMENDATIONS:**\n${investments.map(inv => `• ${inv}`).join('\n')}\n\n` +
        `**KEY RECOMMENDATIONS:**\n${recommendations.map(rec => `• ${rec}`).join('\n')}`
    };
  }

  private createBudget(income: number, expenses: any) {
    const totalExpenses = Object.values(expenses).reduce((sum: number, exp: any) => sum + (Number(exp) || 0), 0);
    const remaining = income - totalExpenses;
    
    return `Total Expenses: $${totalExpenses.toLocaleString()}\nRemaining: $${remaining.toLocaleString()}\nSavings Rate: ${((remaining/income)*100).toFixed(1)}%`;
  }

  private calculateSavings(income: number, expenses: any, goals: string[]) {
    const totalExpenses = Object.values(expenses).reduce((sum: number, exp: any) => sum + (Number(exp) || 0), 0);
    const available = income - totalExpenses;
    const monthlyGoalSaving = available / goals.length;
    
    return `Available for savings: $${available.toLocaleString()}/month\nPer goal allocation: $${monthlyGoalSaving.toLocaleString()}/month`;
  }

  private suggestInvestments(risk: string, goals: string[]) {
    const suggestions: Record<string, string[]> = {
      low: ['High-yield savings', 'CDs', 'Government bonds'],
      medium: ['Index funds', 'Balanced portfolios', 'Blue-chip stocks'],
      high: ['Growth stocks', 'Sector ETFs', 'Alternative investments']
    };
    
    return suggestions[risk] || suggestions.medium;
  }

  private generateFinancialRecommendations(budget: string, savings: string, goals: string[]) {
    return [
      'Build emergency fund covering 3-6 months expenses',
      'Automate savings for consistent progress',
      'Review and adjust plan quarterly',
      'Consider tax-advantaged accounts',
      `Track progress towards ${goals.length} financial goals`
    ];
  }
}

export class PersonalAssistantExtension extends DomainExtension {
  readonly domain = 'personal-assistant';
  readonly name = 'Personal Assistant & Life Management';
  readonly description = 'Comprehensive personal management tools for life planning, health, wellness, and financial goals';
  
  readonly tools = [
    new LifePlanningTool(),
    new HealthWellnessTool(),
    new FinancialPlanningTool()
  ];

  async initialize(): Promise<void> {
    console.log('Personal Assistant Extension initialized');
  }

  getPromptContext(): string {
    return `Personal Assistant & Life Management domain for goal setting, health & wellness, and financial planning.`;
  }
}