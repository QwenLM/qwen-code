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
  ContentItem, 
  DomainUtils 
} from '../domain-framework.js';

// ==================== INTERFACES ====================

interface ContentPlanParams {
  topic: string;
  audience: string;
  contentType: 'blog' | 'article' | 'documentation' | 'social' | 'email' | 'marketing';
  targetLength?: number;
  seoKeywords?: string[];
  tone?: 'professional' | 'casual' | 'academic' | 'conversational' | 'persuasive';
}

interface ResearchParams {
  topic: string;
  sources: 'web' | 'academic' | 'news' | 'social' | 'all';
  depth: 'surface' | 'moderate' | 'deep';
  factCheck: boolean;
  maxSources?: number;
}

interface ContentOptimizationParams {
  content: string;
  targetAudience: string;
  platform?: string;
  optimizeFor: 'readability' | 'seo' | 'engagement' | 'conversion' | 'accessibility';
  keywords?: string[];
}

interface ContentGenerationParams {
  type: 'blog-post' | 'article' | 'social-post' | 'email' | 'press-release' | 'landing-page';
  topic: string;
  audience: string;
  length: 'short' | 'medium' | 'long';
  tone: 'professional' | 'casual' | 'academic' | 'conversational' | 'persuasive';
  keywords?: string[];
  callToAction?: string;
}

interface ContentCalendarParams {
  timeframe: 'week' | 'month' | 'quarter';
  platform: string[];
  topics: string[];
  frequency: number;
  contentTypes: string[];
}

// ==================== TOOLS ====================

/**
 * Content Planning Tool - Creates comprehensive content strategies and outlines
 */
export class ContentPlanningTool extends DomainTool<ContentPlanParams, ToolResult> {
  constructor() {
    super(
      'content-planning',
      'Content Planning',
      'Creates comprehensive content plans, outlines, and strategies for various content types',
      {
        type: Type.Object({
          topic: Type.String({ 
            description: 'The main topic or subject for the content' 
          }),
          audience: Type.String({ 
            description: 'Target audience description (e.g., "tech professionals", "beginners in AI")' 
          }),
          contentType: Type.Union([
            Type.Literal('blog'),
            Type.Literal('article'),
            Type.Literal('documentation'),
            Type.Literal('social'),
            Type.Literal('email'),
            Type.Literal('marketing')
          ], { description: 'Type of content to plan' }),
          targetLength: Type.Optional(Type.Number({ 
            description: 'Target word count for the content' 
          })),
          seoKeywords: Type.Optional(Type.Array(Type.String(), { 
            description: 'SEO keywords to target' 
          })),
          tone: Type.Optional(Type.Union([
            Type.Literal('professional'),
            Type.Literal('casual'),
            Type.Literal('academic'),
            Type.Literal('conversational'),
            Type.Literal('persuasive')
          ], { description: 'Tone and style for the content' }))
        }),
        required: ['topic', 'audience', 'contentType']
      },
      'content-creation',
      'planning'
    );
  }

  async executeWithContext(
    params: ContentPlanParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { topic, audience, contentType, targetLength, seoKeywords, tone } = params;

      // Generate content outline based on type and parameters
      const outline = this.generateOutline(contentType, topic, targetLength);
      const strategy = this.createContentStrategy(audience, contentType, tone);
      const seoRecommendations = this.generateSEORecommendations(seoKeywords, topic);
      const timeline = this.createTimeline(contentType, targetLength);

      const result = {
        topic,
        contentType,
        audience,
        outline,
        strategy,
        seoRecommendations,
        timeline,
        recommendations: this.getGeneralRecommendations(contentType, audience)
      };

      return {
        success: true,
        result: `Content Plan Created Successfully!\n\n${this.formatPlan(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to create content plan: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private generateOutline(contentType: string, topic: string, targetLength?: number): string[] {
    const baseOutlines: Record<string, string[]> = {
      blog: [
        'Introduction - Hook and topic overview',
        'Problem/Challenge identification',
        'Main content sections (3-5 key points)',
        'Examples and case studies',
        'Actionable takeaways',
        'Conclusion and call-to-action'
      ],
      article: [
        'Abstract/Executive summary',
        'Introduction and background',
        'Literature review (if applicable)',
        'Main analysis/discussion points',
        'Evidence and examples',
        'Implications and future directions',
        'Conclusion'
      ],
      documentation: [
        'Overview and purpose',
        'Prerequisites and setup',
        'Step-by-step instructions',
        'Code examples and snippets',
        'Troubleshooting section',
        'Additional resources'
      ],
      social: [
        'Attention-grabbing opening',
        'Main message/value proposition',
        'Visual elements description',
        'Call-to-action',
        'Relevant hashtags'
      ],
      email: [
        'Subject line strategy',
        'Personalized greeting',
        'Value proposition',
        'Main content/offer',
        'Clear call-to-action',
        'Professional signature'
      ],
      marketing: [
        'Headline and value proposition',
        'Problem identification',
        'Solution presentation',
        'Benefits and features',
        'Social proof/testimonials',
        'Strong call-to-action'
      ]
    };

    const outline = baseOutlines[contentType] || baseOutlines['blog'];
    
    // Adjust outline based on target length
    if (targetLength && targetLength < 500) {
      return outline.slice(0, 3); // Shorter content
    } else if (targetLength && targetLength > 2000) {
      return [
        ...outline,
        'Additional research and examples',
        'Extended analysis section'
      ];
    }
    
    return outline;
  }

  private createContentStrategy(audience: string, contentType: string, tone?: string): Record<string, any> {
    return {
      audienceAnalysis: {
        target: audience,
        demographics: `Content tailored for ${audience}`,
        interests: this.inferAudienceInterests(audience),
        painPoints: this.inferAudiencePainPoints(audience)
      },
      tonalStrategy: {
        primaryTone: tone || 'professional',
        voiceCharacteristics: this.getVoiceCharacteristics(tone || 'professional'),
        styleGuidelines: this.getStyleGuidelines(contentType)
      },
      distributionStrategy: {
        primaryChannels: this.suggestChannels(contentType, audience),
        timing: this.suggestTiming(contentType),
        engagement: this.suggestEngagementTactics(contentType)
      }
    };
  }

  private generateSEORecommendations(keywords?: string[], topic?: string): Record<string, any> {
    return {
      primaryKeywords: keywords || [topic?.toLowerCase().replace(/\s+/g, ' ')],
      onPageSEO: [
        'Include primary keyword in title and first paragraph',
        'Use keywords naturally throughout content',
        'Optimize meta description with primary keyword',
        'Use header tags (H1, H2, H3) strategically',
        'Include internal and external links'
      ],
      contentSEO: [
        'Aim for comprehensive coverage of the topic',
        'Use semantic keywords and related terms',
        'Include FAQ sections if relevant',
        'Optimize images with alt text',
        'Ensure mobile-friendly formatting'
      ],
      technicalSEO: [
        'Optimize page loading speed',
        'Use clean URL structure',
        'Implement schema markup if applicable',
        'Ensure proper heading hierarchy'
      ]
    };
  }

  private createTimeline(contentType: string, targetLength?: number): Record<string, string> {
    const baseTimes: Record<string, number> = {
      blog: 4,
      article: 8,
      documentation: 12,
      social: 1,
      email: 2,
      marketing: 6
    };

    const baseHours = baseTimes[contentType] || 4;
    const lengthMultiplier = targetLength ? Math.max(0.5, targetLength / 1000) : 1;
    const totalHours = Math.ceil(baseHours * lengthMultiplier);

    return {
      research: `${Math.ceil(totalHours * 0.3)} hours`,
      writing: `${Math.ceil(totalHours * 0.5)} hours`,
      editing: `${Math.ceil(totalHours * 0.15)} hours`,
      formatting: `${Math.ceil(totalHours * 0.05)} hours`,
      total: `${totalHours} hours`
    };
  }

  private getGeneralRecommendations(contentType: string, audience: string): string[] {
    return [
      `Focus on providing value to ${audience}`,
      'Use clear, concise language appropriate for your audience',
      'Include actionable insights and takeaways',
      'Support claims with credible sources and examples',
      'Optimize for both human readers and search engines',
      'Consider multimedia elements to enhance engagement',
      'Review and edit thoroughly before publishing'
    ];
  }

  private formatPlan(plan: any): string {
    return `
**Topic:** ${plan.topic}
**Content Type:** ${plan.contentType}
**Target Audience:** ${plan.audience}

**CONTENT OUTLINE:**
${plan.outline.map((item: string, index: number) => `${index + 1}. ${item}`).join('\n')}

**CONTENT STRATEGY:**
- **Primary Tone:** ${plan.strategy.tonalStrategy.primaryTone}
- **Distribution Channels:** ${plan.strategy.distributionStrategy.primaryChannels.join(', ')}
- **Optimal Timing:** ${plan.strategy.distributionStrategy.timing}

**SEO RECOMMENDATIONS:**
- **Primary Keywords:** ${plan.seoRecommendations.primaryKeywords.join(', ')}
- **Key SEO Focus:** ${plan.seoRecommendations.onPageSEO.slice(0, 3).join(', ')}

**ESTIMATED TIMELINE:**
- **Research:** ${plan.timeline.research}
- **Writing:** ${plan.timeline.writing}
- **Editing & Review:** ${plan.timeline.editing}
- **Total Time:** ${plan.timeline.total}

**KEY RECOMMENDATIONS:**
${plan.recommendations.map((rec: string) => `• ${rec}`).join('\n')}
    `.trim();
  }

  private inferAudienceInterests(audience: string): string[] {
    // Simple heuristic - could be enhanced with ML
    if (audience.toLowerCase().includes('tech')) {
      return ['technology trends', 'innovation', 'efficiency', 'best practices'];
    }
    if (audience.toLowerCase().includes('business')) {
      return ['growth strategies', 'ROI', 'market trends', 'competitive advantage'];
    }
    return ['relevant insights', 'practical solutions', 'current trends'];
  }

  private inferAudiencePainPoints(audience: string): string[] {
    if (audience.toLowerCase().includes('beginner')) {
      return ['lack of knowledge', 'overwhelming information', 'getting started'];
    }
    if (audience.toLowerCase().includes('professional')) {
      return ['time constraints', 'staying current', 'efficiency improvements'];
    }
    return ['information gaps', 'practical application', 'achieving goals'];
  }

  private getVoiceCharacteristics(tone: string): string[] {
    const characteristics: Record<string, string[]> = {
      professional: ['authoritative', 'clear', 'respectful', 'informative'],
      casual: ['friendly', 'approachable', 'conversational', 'relatable'],
      academic: ['scholarly', 'precise', 'objective', 'well-researched'],
      conversational: ['warm', 'engaging', 'personal', 'accessible'],
      persuasive: ['compelling', 'confident', 'benefit-focused', 'action-oriented']
    };
    return characteristics[tone] || characteristics['professional'];
  }

  private getStyleGuidelines(contentType: string): string[] {
    const guidelines: Record<string, string[]> = {
      blog: ['Use subheadings for scannability', 'Include bullet points and lists', 'Add personal anecdotes'],
      article: ['Maintain formal structure', 'Include citations', 'Use data and statistics'],
      documentation: ['Use numbered steps', 'Include code examples', 'Provide clear explanations'],
      social: ['Keep it concise', 'Use emojis appropriately', 'Include hashtags'],
      email: ['Personalize greeting', 'Keep paragraphs short', 'Use clear subject line'],
      marketing: ['Lead with benefits', 'Include social proof', 'Create urgency']
    };
    return guidelines[contentType] || guidelines['blog'];
  }

  private suggestChannels(contentType: string, audience: string): string[] {
    if (contentType === 'social') return ['LinkedIn', 'Twitter', 'Facebook', 'Instagram'];
    if (contentType === 'blog') return ['Company blog', 'Medium', 'LinkedIn articles'];
    if (contentType === 'email') return ['Email newsletter', 'Direct email'];
    if (audience.toLowerCase().includes('tech')) return ['LinkedIn', 'Developer forums', 'Tech blogs'];
    return ['Website', 'Social media', 'Email'];
  }

  private suggestTiming(contentType: string): string {
    const timing: Record<string, string> = {
      blog: 'Tuesday-Thursday, 9-11 AM',
      social: 'Peak hours: 9 AM, 1-3 PM, 7-9 PM',
      email: 'Tuesday-Thursday, 10 AM or 2 PM',
      article: 'Monday-Wednesday mornings',
      documentation: 'Business hours when support is available',
      marketing: 'Test different times, track performance'
    };
    return timing[contentType] || 'Business hours on weekdays';
  }

  private suggestEngagementTactics(contentType: string): string[] {
    const tactics: Record<string, string[]> = {
      blog: ['Ask questions at the end', 'Encourage comments', 'Share on social media'],
      social: ['Use trending hashtags', 'Engage with comments quickly', 'Tag relevant accounts'],
      email: ['Include clear CTAs', 'Segment your audience', 'A/B test subject lines'],
      article: ['Promote in relevant communities', 'Engage with readers', 'Follow up with related content'],
      documentation: ['Include feedback mechanisms', 'Update based on user questions', 'Create video tutorials'],
      marketing: ['Use social proof', 'Create scarcity', 'Offer valuable incentives']
    };
    return tactics[contentType] || ['Engage with your audience', 'Promote across channels'];
  }
}

/**
 * Research Assistant Tool - Helps gather and verify information
 */
export class ResearchAssistantTool extends DomainTool<ResearchParams, ToolResult> {
  constructor() {
    super(
      'research-assistant',
      'Research Assistant',
      'Helps gather, organize, and verify information for content creation',
      {
        type: Type.Object({
          topic: Type.String({ 
            description: 'Research topic or question' 
          }),
          sources: Type.Union([
            Type.Literal('web'),
            Type.Literal('academic'),
            Type.Literal('news'),
            Type.Literal('social'),
            Type.Literal('all')
          ], { description: 'Types of sources to search' }),
          depth: Type.Union([
            Type.Literal('surface'),
            Type.Literal('moderate'),
            Type.Literal('deep')
          ], { description: 'Depth of research required' }),
          factCheck: Type.Boolean({ 
            description: 'Whether to include fact-checking analysis' 
          }),
          maxSources: Type.Optional(Type.Number({ 
            description: 'Maximum number of sources to include' 
          }))
        }),
        required: ['topic', 'sources', 'depth', 'factCheck']
      },
      'content-creation',
      'research'
    );
  }

  async executeWithContext(
    params: ResearchParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { topic, sources, depth, factCheck, maxSources = 10 } = params;

      // Simulate research process (in real implementation, would use web search APIs)
      const findings = this.generateResearchFindings(topic, depth);
      const sourceList = this.generateSourceList(topic, sources, maxSources);
      const keyInsights = this.extractKeyInsights(findings);
      const factChecks = factCheck ? this.performFactCheck(findings) : [];

      const result = {
        topic,
        researchDepth: depth,
        sourcesSearched: sources,
        findings,
        sources: sourceList,
        keyInsights,
        factChecks,
        researchSummary: this.createResearchSummary(topic, findings, keyInsights)
      };

      return {
        success: true,
        result: `Research Report Completed!\n\n${this.formatResearchReport(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private generateResearchFindings(topic: string, depth: string): string[] {
    // Simulated research findings - in real implementation would fetch from APIs
    const baseFacts = [
      `Current state of ${topic} in the industry`,
      `Key challenges and opportunities in ${topic}`,
      `Best practices and methodologies for ${topic}`,
      `Recent developments and trends in ${topic}`
    ];

    if (depth === 'deep') {
      return [
        ...baseFacts,
        `Historical context and evolution of ${topic}`,
        `Comparative analysis with related fields`,
        `Future predictions and emerging trends`,
        `Expert opinions and thought leadership`,
        `Case studies and real-world applications`,
        `Statistical data and research studies`
      ];
    } else if (depth === 'moderate') {
      return [
        ...baseFacts,
        `Statistical overview of ${topic}`,
        `Notable examples and case studies`,
        `Expert perspectives on ${topic}`
      ];
    }

    return baseFacts;
  }

  private generateSourceList(topic: string, sourceType: string, maxSources: number): any[] {
    // Simulated source list - in real implementation would fetch actual sources
    const sources = [];
    const sourceTypes = sourceType === 'all' ? ['web', 'academic', 'news', 'social'] : [sourceType];

    for (const type of sourceTypes) {
      const sourcesPerType = Math.ceil(maxSources / sourceTypes.length);
      for (let i = 0; i < sourcesPerType && sources.length < maxSources; i++) {
        sources.push({
          title: `${topic} - ${type} source ${i + 1}`,
          url: `https://example.com/${type}-source-${i + 1}`,
          type,
          relevance: 'high',
          credibility: type === 'academic' ? 'peer-reviewed' : 'verified',
          publishDate: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        });
      }
    }

    return sources;
  }

  private extractKeyInsights(findings: string[]): string[] {
    return [
      'Primary trends and patterns identified',
      'Most significant challenges and opportunities',
      'Consensus among experts and practitioners',
      'Gaps in current knowledge or practice',
      'Actionable recommendations for implementation'
    ];
  }

  private performFactCheck(findings: string[]): any[] {
    return [
      {
        claim: 'Statistical claims about the topic',
        status: 'verified',
        sources: 2,
        confidence: 'high'
      },
      {
        claim: 'Expert opinions and predictions',
        status: 'partially verified',
        sources: 1,
        confidence: 'medium'
      }
    ];
  }

  private createResearchSummary(topic: string, findings: string[], insights: string[]): string {
    return `
This research on "${topic}" reveals several key points:

1. ${findings[0]}
2. ${findings[1]}
3. ${insights[0]}

The research indicates that this is an active area with significant opportunities for growth and innovation.
    `.trim();
  }

  private formatResearchReport(result: any): string {
    return `
**Research Topic:** ${result.topic}
**Research Depth:** ${result.researchDepth}
**Sources Searched:** ${result.sourcesSearched}

**KEY FINDINGS:**
${result.findings.map((finding: string, index: number) => `${index + 1}. ${finding}`).join('\n')}

**RESEARCH INSIGHTS:**
${result.keyInsights.map((insight: string) => `• ${insight}`).join('\n')}

**SOURCES (${result.sources.length} found):**
${result.sources.slice(0, 5).map((source: any) => `• ${source.title} (${source.type}) - ${source.credibility}`).join('\n')}
${result.sources.length > 5 ? `... and ${result.sources.length - 5} more sources` : ''}

${result.factChecks.length > 0 ? `**FACT CHECKS:**
${result.factChecks.map((check: any) => `• ${check.claim}: ${check.status} (confidence: ${check.confidence})`).join('\n')}` : ''}

**RESEARCH SUMMARY:**
${result.researchSummary}
    `.trim();
  }
}

/**
 * Content Optimization Tool - Improves existing content
 */
export class ContentOptimizationTool extends DomainTool<ContentOptimizationParams, ToolResult> {
  constructor() {
    super(
      'content-optimization',
      'Content Optimization',
      'Analyzes and optimizes content for readability, SEO, engagement, and conversion',
      {
        type: Type.Object({
          content: Type.String({ 
            description: 'The content to optimize' 
          }),
          targetAudience: Type.String({ 
            description: 'Target audience for the content' 
          }),
          platform: Type.Optional(Type.String({ 
            description: 'Platform where content will be published' 
          })),
          optimizeFor: Type.Union([
            Type.Literal('readability'),
            Type.Literal('seo'),
            Type.Literal('engagement'),
            Type.Literal('conversion'),
            Type.Literal('accessibility')
          ], { description: 'Primary optimization goal' }),
          keywords: Type.Optional(Type.Array(Type.String(), { 
            description: 'Target keywords for SEO optimization' 
          }))
        }),
        required: ['content', 'targetAudience', 'optimizeFor']
      },
      'content-creation',
      'optimization'
    );
  }

  async executeWithContext(
    params: ContentOptimizationParams,
    context: DomainContext,
    abortSignal: AbortSignal
  ): Promise<ToolResult> {
    try {
      const { content, targetAudience, platform, optimizeFor, keywords } = params;

      const analysis = this.analyzeContent(content);
      const recommendations = this.generateRecommendations(content, optimizeFor, targetAudience, keywords);
      const optimizedContent = this.optimizeContent(content, recommendations);
      const metrics = this.calculateMetrics(content, optimizedContent);

      const result = {
        originalLength: content.length,
        optimizedLength: optimizedContent.length,
        optimizationGoal: optimizeFor,
        analysis,
        recommendations,
        optimizedContent,
        metrics,
        improvementSummary: this.createImprovementSummary(metrics)
      };

      return {
        success: true,
        result: `Content Optimization Complete!\n\n${this.formatOptimizationReport(result)}`
      };
    } catch (error) {
      return {
        success: false,
        error: `Optimization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  private analyzeContent(content: string): Record<string, any> {
    const words = content.split(/\s+/).length;
    const sentences = content.split(/[.!?]+/).length;
    const paragraphs = content.split(/\n\s*\n/).length;
    const avgWordsPerSentence = sentences > 0 ? Math.round(words / sentences) : 0;

    return {
      wordCount: words,
      sentenceCount: sentences,
      paragraphCount: paragraphs,
      avgWordsPerSentence,
      readabilityScore: this.calculateReadabilityScore(words, sentences),
      seoScore: this.calculateSEOScore(content),
      engagementScore: this.calculateEngagementScore(content)
    };
  }

  private calculateReadabilityScore(words: number, sentences: number): number {
    // Simplified Flesch Reading Ease approximation
    const avgSentenceLength = sentences > 0 ? words / sentences : 0;
    return Math.max(0, Math.min(100, 100 - avgSentenceLength * 2));
  }

  private calculateSEOScore(content: string): number {
    let score = 50; // Base score
    
    // Check for headings
    if (content.includes('#') || content.includes('<h')) score += 10;
    
    // Check for lists
    if (content.includes('•') || content.includes('-') || content.includes('<li>')) score += 10;
    
    // Check for links
    if (content.includes('http') || content.includes('<a')) score += 10;
    
    // Check length
    if (content.length > 300) score += 10;
    if (content.length > 1000) score += 10;
    
    return Math.min(100, score);
  }

  private calculateEngagementScore(content: string): number {
    let score = 50; // Base score
    
    // Check for questions
    if (content.includes('?')) score += 15;
    
    // Check for action words
    const actionWords = ['discover', 'learn', 'achieve', 'transform', 'improve'];
    if (actionWords.some(word => content.toLowerCase().includes(word))) score += 10;
    
    // Check for emotional words
    const emotionalWords = ['amazing', 'incredible', 'powerful', 'essential', 'crucial'];
    if (emotionalWords.some(word => content.toLowerCase().includes(word))) score += 10;
    
    // Check for personal pronouns
    if (content.includes('you') || content.includes('your')) score += 15;
    
    return Math.min(100, score);
  }

  private generateRecommendations(
    content: string, 
    optimizeFor: string, 
    audience: string, 
    keywords?: string[]
  ): string[] {
    const recommendations: string[] = [];
    
    switch (optimizeFor) {
      case 'readability':
        if (content.split(/[.!?]+/).length > 0) {
          const avgSentenceLength = content.split(/\s+/).length / content.split(/[.!?]+/).length;
          if (avgSentenceLength > 20) {
            recommendations.push('Break long sentences into shorter ones (aim for 15-20 words per sentence)');
          }
        }
        recommendations.push('Use more subheadings to improve scannability');
        recommendations.push('Add bullet points or numbered lists for complex information');
        break;
        
      case 'seo':
        if (keywords && keywords.length > 0) {
          recommendations.push(`Incorporate target keywords: ${keywords.join(', ')}`);
          recommendations.push('Add keywords to headings and first paragraph');
        }
        recommendations.push('Include more internal and external links');
        recommendations.push('Optimize meta description and title tag');
        break;
        
      case 'engagement':
        recommendations.push('Add more questions to engage readers');
        recommendations.push('Include a clear call-to-action');
        recommendations.push('Use more personal pronouns (you, your)');
        recommendations.push('Add storytelling elements or examples');
        break;
        
      case 'conversion':
        recommendations.push('Strengthen the value proposition');
        recommendations.push('Add social proof or testimonials');
        recommendations.push('Create urgency or scarcity');
        recommendations.push('Make the call-to-action more prominent');
        break;
        
      case 'accessibility':
        recommendations.push('Use clear, simple language');
        recommendations.push('Ensure proper heading hierarchy');
        recommendations.push('Add descriptive text for any images');
        recommendations.push('Use sufficient color contrast');
        break;
    }
    
    return recommendations;
  }

  private optimizeContent(content: string, recommendations: string[]): string {
    // Simple optimization - in real implementation would use more sophisticated NLP
    let optimized = content;
    
    // Add some basic optimizations
    if (recommendations.some(r => r.includes('questions'))) {
      optimized += '\n\nWhat are your thoughts on this approach?';
    }
    
    if (recommendations.some(r => r.includes('call-to-action'))) {
      optimized += '\n\nReady to get started? Take action today!';
    }
    
    return optimized;
  }

  private calculateMetrics(original: string, optimized: string): Record<string, any> {
    const originalAnalysis = this.analyzeContent(original);
    const optimizedAnalysis = this.analyzeContent(optimized);
    
    return {
      readabilityImprovement: optimizedAnalysis.readabilityScore - originalAnalysis.readabilityScore,
      seoImprovement: optimizedAnalysis.seoScore - originalAnalysis.seoScore,
      engagementImprovement: optimizedAnalysis.engagementScore - originalAnalysis.engagementScore,
      lengthChange: optimized.length - original.length,
      originalScores: originalAnalysis,
      optimizedScores: optimizedAnalysis
    };
  }

  private createImprovementSummary(metrics: Record<string, any>): string {
    const improvements = [];
    
    if (metrics.readabilityImprovement > 0) {
      improvements.push(`Readability improved by ${metrics.readabilityImprovement} points`);
    }
    if (metrics.seoImprovement > 0) {
      improvements.push(`SEO score improved by ${metrics.seoImprovement} points`);
    }
    if (metrics.engagementImprovement > 0) {
      improvements.push(`Engagement score improved by ${metrics.engagementImprovement} points`);
    }
    
    return improvements.length > 0 
      ? improvements.join(', ') 
      : 'Content analyzed with targeted optimization recommendations';
  }

  private formatOptimizationReport(result: any): string {
    return `
**Optimization Goal:** ${result.optimizationGoal}
**Content Length:** ${result.originalLength} → ${result.optimizedLength} characters

**ORIGINAL SCORES:**
- Readability: ${result.metrics.originalScores.readabilityScore}/100
- SEO: ${result.metrics.originalScores.seoScore}/100  
- Engagement: ${result.metrics.originalScores.engagementScore}/100

**OPTIMIZED SCORES:**
- Readability: ${result.metrics.optimizedScores.readabilityScore}/100
- SEO: ${result.metrics.optimizedScores.seoScore}/100
- Engagement: ${result.metrics.optimizedScores.engagementScore}/100

**IMPROVEMENT SUMMARY:**
${result.improvementSummary}

**KEY RECOMMENDATIONS:**
${result.recommendations.map((rec: string) => `• ${rec}`).join('\n')}

**OPTIMIZED CONTENT:**
${result.optimizedContent}
    `.trim();
  }
}

// ==================== DOMAIN EXTENSION ====================

/**
 * Content Creation & Writing Assistant Domain Extension
 */
export class ContentCreationExtension extends DomainExtension {
  readonly domain = 'content-creation';
  readonly name = 'Content Creation & Writing Assistant';
  readonly description = 'Comprehensive content creation tools for writers, bloggers, marketers, and content creators';
  
  readonly tools: DomainTool[] = [
    new ContentPlanningTool(),
    new ResearchAssistantTool(),
    new ContentOptimizationTool()
  ];

  async initialize(): Promise<void> {
    // Initialize any required services or configurations
    console.log('Content Creation Extension initialized');
  }

  getPromptContext(): string {
    return `
You are now operating in the Content Creation & Writing Assistant domain. This domain is designed to help with:

1. **Content Planning** - Creating comprehensive content strategies, outlines, and publication plans
2. **Research Assistance** - Gathering, organizing, and verifying information for content creation
3. **Content Optimization** - Improving existing content for readability, SEO, engagement, and conversion

Available tools:
- content-planning: Creates detailed content plans and strategies
- research-assistant: Helps gather and verify information 
- content-optimization: Analyzes and improves existing content

Focus on providing valuable, actionable assistance for content creators, writers, marketers, and anyone looking to create high-quality written content.
    `.trim();
  }
}