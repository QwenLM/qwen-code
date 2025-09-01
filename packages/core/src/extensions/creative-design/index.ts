/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@sinclair/typebox';
import { ToolResult } from '@qwen-code/qwen-code-core';
import { DomainExtension, DomainTool, DomainContext, DomainUtils } from '../domain-framework.js';

// Creative & Design Assistant Domain Extension
export class DesignConceptTool extends DomainTool {
  constructor() {
    super(
      'design-concept',
      'Design Concept',
      'Generates design concepts, style guides, and visual direction for creative projects',
      {
        type: Type.Object({
          projectType: Type.Union([Type.Literal('logo'), Type.Literal('website'), Type.Literal('app'), Type.Literal('branding'), Type.Literal('marketing')]),
          style: Type.String({ description: 'Design style preference (e.g., "modern", "minimalist", "vintage")' }),
          targetAudience: Type.String(),
          brandValues: Type.Array(Type.String()),
          inspiration: Type.Optional(Type.Array(Type.String()))
        }),
        required: ['projectType', 'style', 'targetAudience', 'brandValues']
      },
      'creative-design',
      'concept'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { projectType, style, targetAudience, brandValues, inspiration } = params;
    
    const concepts = this.generateDesignConcepts(projectType, style, brandValues);
    const colorPalette = this.suggestColorPalette(style, brandValues);
    const typography = this.recommendTypography(style, projectType);
    const styleGuide = this.createStyleGuide(concepts, colorPalette, typography);
    
    return {
      success: true,
      result: `Design concept for ${projectType} created!\n\n` +
        `**STYLE:** ${style} design for ${targetAudience}\n\n` +
        `**BRAND VALUES:** ${brandValues.join(', ')}\n\n` +
        `**DESIGN CONCEPTS:**\n${concepts.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\n` +
        `**COLOR PALETTE:** ${colorPalette.join(', ')}\n\n` +
        `**TYPOGRAPHY:** ${typography}\n\n` +
        `**STYLE GUIDE:**\n${styleGuide}`
    };
  }

  private generateDesignConcepts(type: string, style: string, values: string[]) {
    return [
      `${style} ${type} emphasizing ${values[0] || 'quality'}`,
      `Clean, professional design reflecting ${values[1] || 'trust'}`,
      `Modern approach highlighting ${values[2] || 'innovation'}`
    ];
  }

  private suggestColorPalette(style: string, values: string[]) {
    const palettes: Record<string, string[]> = {
      modern: ['#2563EB', '#F8FAFC', '#1E293B'],
      minimalist: ['#000000', '#FFFFFF', '#F1F5F9'],
      vintage: ['#8B4513', '#F5DEB3', '#2F4F4F'],
      professional: ['#1E40AF', '#F9FAFB', '#374151']
    };
    
    return palettes[style.toLowerCase()] || palettes.modern;
  }

  private recommendTypography(style: string, type: string) {
    return `${style} typography with clean, readable fonts suitable for ${type} applications`;
  }

  private createStyleGuide(concepts: string[], colors: string[], typography: string) {
    return `Primary concept: ${concepts[0]}\nColor scheme: ${colors.join(', ')}\nTypography: ${typography}\nUsage guidelines and brand consistency rules`;
  }
}

export class BrandStrategyTool extends DomainTool {
  constructor() {
    super(
      'brand-strategy',
      'Brand Strategy',
      'Develops comprehensive brand strategies, positioning, and messaging frameworks',
      {
        type: Type.Object({
          businessType: Type.String(),
          targetMarket: Type.String(),
          competitors: Type.Array(Type.String()),
          uniqueValueProp: Type.String(),
          brandPersonality: Type.Array(Type.String())
        }),
        required: ['businessType', 'targetMarket', 'uniqueValueProp', 'brandPersonality']
      },
      'creative-design',
      'strategy'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { businessType, targetMarket, competitors, uniqueValueProp, brandPersonality } = params;
    
    const positioning = this.developPositioning(businessType, targetMarket, uniqueValueProp);
    const messaging = this.createMessaging(brandPersonality, targetMarket);
    const differentiation = this.analyzeDifferentiation(competitors || [], uniqueValueProp);
    
    return {
      success: true,
      result: `Brand strategy for ${businessType} developed!\n\n` +
        `**TARGET MARKET:** ${targetMarket}\n\n` +
        `**UNIQUE VALUE PROPOSITION:** ${uniqueValueProp}\n\n` +
        `**BRAND PERSONALITY:** ${brandPersonality.join(', ')}\n\n` +
        `**POSITIONING:**\n${positioning}\n\n` +
        `**KEY MESSAGING:**\n${messaging}\n\n` +
        `**DIFFERENTIATION:**\n${differentiation}`
    };
  }

  private developPositioning(business: string, market: string, uvp: string) {
    return `Positioned as the leading ${business} solution for ${market}, delivering ${uvp} through innovative and reliable services.`;
  }

  private createMessaging(personality: string[], market: string) {
    return personality.map((trait, i) => `${i+1}. ${trait}: Messaging that resonates with ${market}`).join('\n');
  }

  private analyzeDifferentiation(competitors: string[], uvp: string) {
    return `Differentiated from ${competitors.length} competitors through ${uvp} and unique market approach.`;
  }
}

export class CreativeBrainstormingTool extends DomainTool {
  constructor() {
    super(
      'creative-brainstorming',
      'Creative Brainstorming',
      'Generates creative ideas, concepts, and solutions using various brainstorming techniques',
      {
        type: Type.Object({
          challenge: Type.String(),
          domain: Type.String(),
          constraints: Type.Array(Type.String()),
          inspirationSources: Type.Array(Type.String()),
          brainstormingMethod: Type.Union([Type.Literal('lateral'), Type.Literal('structured'), Type.Literal('associative')])
        }),
        required: ['challenge', 'domain', 'brainstormingMethod']
      },
      'creative-design',
      'brainstorming'
    );
  }

  async executeWithContext(params: any, context: DomainContext, abortSignal: AbortSignal): Promise<ToolResult> {
    const { challenge, domain, constraints, inspirationSources, brainstormingMethod } = params;
    
    const ideas = this.generateIdeas(challenge, domain, brainstormingMethod);
    const concepts = this.developConcepts(ideas, constraints || []);
    const evaluation = this.evaluateIdeas(concepts);
    
    return {
      success: true,
      result: `Creative brainstorming for "${challenge}" complete!\n\n` +
        `**METHOD:** ${brainstormingMethod} thinking\n\n` +
        `**GENERATED IDEAS:**\n${ideas.map((idea, i) => `${i+1}. ${idea}`).join('\n')}\n\n` +
        `**DEVELOPED CONCEPTS:**\n${concepts.map((concept, i) => `${i+1}. ${concept}`).join('\n')}\n\n` +
        `**EVALUATION:**\n${evaluation}`
    };
  }

  private generateIdeas(challenge: string, domain: string, method: string) {
    const ideaStarters = [
      `Revolutionary approach to ${challenge}`,
      `${domain}-specific solution leveraging technology`,
      `Community-driven response to ${challenge}`,
      `Sustainable and scalable ${challenge} solution`,
      `Cross-industry inspiration for ${challenge}`
    ];
    
    return ideaStarters.map(starter => `${starter} using ${method} thinking`);
  }

  private developConcepts(ideas: string[], constraints: string[]) {
    return ideas.slice(0, 3).map(idea => 
      `${idea} - developed considering constraints: ${constraints.join(', ') || 'standard limitations'}`
    );
  }

  private evaluateIdeas(concepts: string[]) {
    return concepts.map((concept, i) => 
      `Concept ${i+1}: Feasible with strong potential for impact and innovation`
    ).join('\n');
  }
}

export class CreativeDesignExtension extends DomainExtension {
  readonly domain = 'creative-design';
  readonly name = 'Creative & Design Assistant';
  readonly description = 'Creative ideation, design concepts, brand strategy, and visual communication tools';
  
  readonly tools = [
    new DesignConceptTool(),
    new BrandStrategyTool(),
    new CreativeBrainstormingTool()
  ];

  async initialize(): Promise<void> {
    console.log('Creative & Design Extension initialized');
  }

  getPromptContext(): string {
    return `Creative & Design Assistant domain for design concepts, brand strategy, and creative problem-solving.`;
  }
}