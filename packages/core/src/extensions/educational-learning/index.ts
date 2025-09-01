/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@sinclair/typebox';
import { ToolResult } from '@qwen-code/qwen-code-core';
import { DomainExtension, DomainTool, DomainContext, DomainUtils } from '../domain-framework.js';

// Educational & Learning Platform Domain Extension
export class CurriculumDevelopmentTool extends DomainTool {
  constructor() {
    super(
      'curriculum-development',
      'Curriculum Development',
      'Creates structured learning curricula with objectives, modules, and assessments',
      {
        type: Type.Object({
          subject: Type.String({ description: 'Subject or topic area' }),
          level: Type.Union([Type.Literal('beginner'), Type.Literal('intermediate'), Type.Literal('advanced')]),
          duration: Type.String({ description: 'Course duration (e.g., "8 weeks", "3 months")' }),
          learningObjectives: Type.Array(Type.String()),
          assessmentMethods: Type.Array(Type.String())
        }),
        required: ['subject', 'level', 'duration', 'learningObjectives']
      },
      'educational-learning',
      'curriculum'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { subject, level, duration, learningObjectives, assessmentMethods } = params;
    
    const modules = this.generateModules(subject, level, learningObjectives);
    const timeline = this.createTimeline(duration, modules.length);
    const assessments = this.designAssessments(assessmentMethods || ['quiz', 'project'], level);
    
    return {
      success: true,
      result: `Curriculum for ${subject} (${level} level) created!\n\n` +
        `**MODULES (${modules.length}):**\n${modules.map((m, i) => `${i+1}. ${m.title}: ${m.description}`).join('\n')}\n\n` +
        `**TIMELINE:** ${timeline}\n\n` +
        `**ASSESSMENTS:**\n${assessments.map(a => `• ${a.type}: ${a.description}`).join('\n')}`
    };
  }

  private generateModules(subject: string, level: string, objectives: string[]) {
    return objectives.map((obj, i) => ({
      title: `Module ${i+1}: ${obj}`,
      description: `${level} level content for ${obj.toLowerCase()}`,
      duration: '1-2 weeks',
      activities: ['Reading materials', 'Interactive exercises', 'Practice problems']
    }));
  }

  private createTimeline(duration: string, moduleCount: number) {
    return `${duration} total, approximately ${Math.ceil(parseInt(duration) / moduleCount)} per module`;
  }

  private designAssessments(methods: string[], level: string) {
    return methods.map(method => ({
      type: method,
      description: `${level} level ${method} assessment`,
      weight: '25%'
    }));
  }
}

export class InteractiveLearningTool extends DomainTool {
  constructor() {
    super(
      'interactive-learning',
      'Interactive Learning',
      'Creates interactive learning experiences, quizzes, and exercises',
      {
        type: Type.Object({
          topic: Type.String(),
          learningStyle: Type.Union([Type.Literal('visual'), Type.Literal('auditory'), Type.Literal('kinesthetic'), Type.Literal('reading')]),
          difficulty: Type.Union([Type.Literal('easy'), Type.Literal('medium'), Type.Literal('hard')]),
          interactionType: Type.Union([Type.Literal('quiz'), Type.Literal('exercise'), Type.Literal('project'), Type.Literal('discussion')])
        }),
        required: ['topic', 'learningStyle', 'difficulty', 'interactionType']
      },
      'educational-learning',
      'interactive'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { topic, learningStyle, difficulty, interactionType } = params;
    
    const content = this.generateInteractiveContent(topic, learningStyle, difficulty, interactionType);
    
    return {
      success: true,
      result: `Interactive ${interactionType} for ${topic} created!\n\n${content}`
    };
  }

  private generateInteractiveContent(topic: string, style: string, difficulty: string, type: string) {
    if (type === 'quiz') {
      return `**${difficulty.toUpperCase()} QUIZ: ${topic}**\n\n` +
        `1. What is the main concept of ${topic}?\n` +
        `2. How does ${topic} apply in practice?\n` +
        `3. What are the key benefits of ${topic}?\n\n` +
        `*Adapted for ${style} learners with ${difficulty} difficulty*`;
    }
    
    return `**${type.toUpperCase()}: ${topic}**\n\n` +
      `Interactive ${type} designed for ${style} learning style at ${difficulty} level.\n` +
      `Includes hands-on activities and immediate feedback.`;
  }
}

export class TutoringAssistantTool extends DomainTool {
  constructor() {
    super(
      'tutoring-assistant',
      'Tutoring Assistant',
      'Provides personalized tutoring and guidance based on student needs',
      {
        type: Type.Object({
          student: Type.String(),
          subject: Type.String(),
          currentLevel: Type.String(),
          strugglingAreas: Type.Array(Type.String()),
          preferredMethods: Type.Array(Type.String())
        }),
        required: ['student', 'subject', 'currentLevel', 'strugglingAreas']
      },
      'educational-learning',
      'tutoring'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { student, subject, currentLevel, strugglingAreas, preferredMethods } = params;
    
    const plan = this.createPersonalizedPlan(student, subject, currentLevel, strugglingAreas);
    const exercises = this.generatePracticeExercises(strugglingAreas, currentLevel);
    
    return {
      success: true,
      result: `Personalized tutoring plan for ${student} in ${subject}!\n\n` +
        `**CURRENT LEVEL:** ${currentLevel}\n\n` +
        `**FOCUS AREAS:**\n${strugglingAreas.map(area => `• ${area}`).join('\n')}\n\n` +
        `**RECOMMENDED PLAN:**\n${plan}\n\n` +
        `**PRACTICE EXERCISES:**\n${exercises}`
    };
  }

  private createPersonalizedPlan(student: string, subject: string, level: string, areas: string[]) {
    return `1. Assessment of current ${subject} knowledge\n` +
      `2. Targeted instruction on: ${areas.join(', ')}\n` +
      `3. Progressive practice with feedback\n` +
      `4. Regular progress evaluation`;
  }

  private generatePracticeExercises(areas: string[], level: string) {
    return areas.map((area, i) => `${i+1}. ${level} level exercises for ${area}`).join('\n');
  }
}

export class EducationalLearningExtension extends DomainExtension {
  readonly domain = 'educational-learning';
  readonly name = 'Educational & Learning Platform';
  readonly description = 'Personalized learning experiences, curriculum development, and educational content creation';
  
  readonly tools = [
    new CurriculumDevelopmentTool(),
    new InteractiveLearningTool(), 
    new TutoringAssistantTool()
  ];

  async initialize(): Promise<void> {
    console.log('Educational & Learning Extension initialized');
  }

  getPromptContext(): string {
    return `Educational & Learning Platform domain for personalized education, curriculum development, and interactive learning experiences.`;
  }
}