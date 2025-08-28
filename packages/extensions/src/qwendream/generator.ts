/**
 * Story Generator for QwenDream
 * Converts code analysis into engaging narratives
 */

export interface StoryGenerationOptions {
  type: string;
  format: string;
  duration: number;
  interactive: boolean;
  visualNovel: boolean;
  includeCode: boolean;
}

export interface GeneratedStory {
  title: string;
  subtitle: string;
  type: string;
  projectName: string;
  estimatedDuration: number;
  characters: StoryCharacter[];
  chapters: Chapter[];
  plotPoints: StoryPlotPoint[];
  themes: string[];
  opening: StoryScene;
  climax: StoryScene;
  resolution: StoryScene;
  choices?: StoryChoice[];
  codeSnippets?: CodeSnippet[];
  content?: string;
}

export interface StoryCharacter {
  name: string;
  type: string;
  role: string;
  description: string;
  codeOrigin: string;
  personality: string;
  arc: string;
  codeSnippet?: string;
}

export interface Chapter {
  title: string;
  content: string;
  codeSnippets?: CodeSnippet[];
  characters: string[];
  themes: string[];
}

export interface StoryPlotPoint {
  title: string;
  description: string;
  chapter: number;
  tension: number;
  codeContext: string;
}

export interface StoryScene {
  title: string;
  content: string;
  characters: string[];
  significance: string;
}

export interface StoryChoice {
  id: string;
  text: string;
  consequence: string;
  codeEffect: string;
  nextScene: string;
}

export interface CodeSnippet {
  code: string;
  context: string;
  purpose: string;
  file: string;
}

export class StoryGenerator {
  private readonly STORY_TEMPLATES = {
    adventure: {
      title: "The Great Code Quest",
      opening: "In a digital realm where logic reigns supreme...",
      themes: ["discovery", "challenge", "growth", "triumph"]
    },
    mystery: {
      title: "The Enigmatic Algorithm",
      opening: "Something strange was happening in the codebase...",
      themes: ["investigation", "secrets", "revelation", "truth"]
    },
    scifi: {
      title: "Chronicles of the Digital Frontier", 
      opening: "In the year 2024, when artificial intelligence...",
      themes: ["technology", "innovation", "future", "evolution"]
    },
    fantasy: {
      title: "The Magical Kingdom of Code",
      opening: "Once upon a time, in a mystical land of algorithms...",
      themes: ["magic", "wonder", "transformation", "destiny"]
    },
    documentary: {
      title: "Inside the Codebase: A Technical Journey",
      opening: "This is the story of how a simple idea became...",
      themes: ["education", "process", "methodology", "insight"]
    }
  };

  private readonly CHARACTER_ARCHETYPES = {
    protagonist: ['Main Character', 'Hero', 'Lead Developer', 'System Core'],
    mentor: ['Wise Guide', 'Senior Function', 'Master Class', 'Configuration Keeper'],
    ally: ['Faithful Helper', 'Supporting Module', 'Utility Function', 'Service Layer'],
    guardian: ['Code Protector', 'Validation Guard', 'Security Module', 'Error Handler'],
    trickster: ['Unpredictable Element', 'Random Generator', 'Edge Case Handler', 'Debug Helper']
  };

  async generate(analysis: any, options: StoryGenerationOptions): Promise<GeneratedStory> {
    console.log(`✍️ Generating ${options.type} story...`);

    const template = this.STORY_TEMPLATES[options.type as keyof typeof this.STORY_TEMPLATES] || this.STORY_TEMPLATES.adventure;
    
    const story: GeneratedStory = {
      title: this.generateTitle(analysis, template, options.type),
      subtitle: this.generateSubtitle(analysis, options.type),
      type: options.type,
      projectName: analysis.projectName,
      estimatedDuration: options.duration,
      characters: this.createStoryCharacters(analysis.characters),
      chapters: await this.generateChapters(analysis, options),
      plotPoints: this.createPlotPoints(analysis.plotPoints),
      themes: this.extractStoryThemes(analysis.themes),
      opening: this.createOpening(analysis, template),
      climax: this.createClimax(analysis, options.type),
      resolution: this.createResolution(analysis, options.type),
      codeSnippets: options.includeCode ? this.selectCodeSnippets(analysis) : undefined
    };

    if (options.interactive) {
      story.choices = this.generateChoices(analysis, options.type);
    }

    if (!options.interactive && options.format !== 'vn') {
      story.content = this.generateLinearNarrative(story, analysis);
    }

    return story;
  }

  private generateTitle(analysis: any, template: any, type: string): string {
    const projectName = analysis.projectName;
    const baseTitle = template.title;
    
    const titleVariations = {
      adventure: [
        `The ${projectName} Quest`,
        `Adventures in ${projectName}`,
        `Journey Through ${projectName}`,
        `The Chronicles of ${projectName}`
      ],
      mystery: [
        `The ${projectName} Mystery`,
        `Secrets of ${projectName}`,
        `The Enigma of ${projectName}`,
        `Unraveling ${projectName}`
      ],
      scifi: [
        `${projectName}: A Digital Odyssey`,
        `The ${projectName} Protocol`,
        `Chronicles of ${projectName}`,
        `${projectName}: Future Systems`
      ],
      fantasy: [
        `The Magical Realm of ${projectName}`,
        `${projectName}: A Code Fairy Tale`,
        `The Enchanted ${projectName}`,
        `Legends of ${projectName}`
      ],
      documentary: [
        `Inside ${projectName}`,
        `The Making of ${projectName}`,
        `${projectName}: Behind the Code`,
        `Understanding ${projectName}`
      ]
    };

    const variations = titleVariations[type as keyof typeof titleVariations] || titleVariations.adventure;
    return variations[Math.floor(Math.random() * variations.length)];
  }

  private generateSubtitle(analysis: any, type: string): string {
    const subtitles = {
      adventure: 'An Epic Journey Through Code',
      mystery: 'A Tale of Hidden Algorithms',
      scifi: 'The Future of Digital Innovation', 
      fantasy: 'Where Magic Meets Technology',
      documentary: 'The Technical Story Unveiled'
    };
    
    return subtitles[type as keyof typeof subtitles] || 'A Code Story';
  }

  private createStoryCharacters(analysisCharacters: any[]): StoryCharacter[] {
    return analysisCharacters.slice(0, 10).map(char => ({
      name: char.name,
      type: char.type,
      role: char.role,
      description: this.enhanceCharacterDescription(char),
      codeOrigin: char.codeOrigin,
      personality: char.personality || this.assignPersonality(char),
      arc: this.generateCharacterArc(char),
      codeSnippet: char.codeSnippet
    }));
  }

  private async generateChapters(analysis: any, options: StoryGenerationOptions): Promise<Chapter[]> {
    const chapterCount = Math.min(8, Math.max(3, Math.floor(options.duration / 5)));
    const chapters: Chapter[] = [];

    for (let i = 0; i < chapterCount; i++) {
      const chapter = await this.generateChapter(i, chapterCount, analysis, options);
      chapters.push(chapter);
    }

    return chapters;
  }

  private async generateChapter(index: number, total: number, analysis: any, options: StoryGenerationOptions): Promise<Chapter> {
    const chapterTemplates = {
      0: { title: 'The Beginning', focus: 'introduction' },
      1: { title: 'First Encounters', focus: 'character_introduction' },
      2: { title: 'Rising Action', focus: 'problem_development' },
      3: { title: 'The Challenge', focus: 'conflict' },
      4: { title: 'Deeper Understanding', focus: 'complexity' },
      5: { title: 'The Turning Point', focus: 'climax' },
      6: { title: 'Resolution', focus: 'solution' },
      7: { title: 'New Beginnings', focus: 'conclusion' }
    };

    const template = chapterTemplates[Math.min(index, 7) as keyof typeof chapterTemplates];
    const progress = index / (total - 1);

    return {
      title: `Chapter ${index + 1}: ${template.title}`,
      content: await this.generateChapterContent(template.focus, analysis, options, progress),
      codeSnippets: options.includeCode ? this.selectChapterCodeSnippets(analysis, index) : undefined,
      characters: this.selectChapterCharacters(analysis.characters, index),
      themes: this.selectChapterThemes(analysis.themes, template.focus)
    };
  }

  private async generateChapterContent(focus: string, analysis: any, options: StoryGenerationOptions, progress: number): Promise<string> {
    const contentGenerators = {
      introduction: () => this.generateIntroductionContent(analysis, options),
      character_introduction: () => this.generateCharacterIntroContent(analysis),
      problem_development: () => this.generateProblemContent(analysis),
      conflict: () => this.generateConflictContent(analysis),
      complexity: () => this.generateComplexityContent(analysis),
      climax: () => this.generateClimaxContent(analysis, options),
      solution: () => this.generateSolutionContent(analysis),
      conclusion: () => this.generateConclusionContent(analysis, options)
    };

    const generator = contentGenerators[focus as keyof typeof contentGenerators] || contentGenerators.introduction;
    return generator();
  }

  private generateIntroductionContent(analysis: any, options: StoryGenerationOptions): string {
    const typeIntros = {
      adventure: `In the vast digital landscape of ${analysis.projectName}, where ${analysis.files.length} files formed an intricate web of functionality, our journey begins. Each line of code held secrets waiting to be discovered, and every function promised adventure for those brave enough to explore.`,
      
      mystery: `Something was amiss in the ${analysis.projectName} codebase. The developers had noticed strange patterns, unexplained behaviors, and mysterious comments scattered throughout the ${analysis.files.length} files. Our investigation begins where logic meets the unknown.`,
      
      scifi: `In the year of digital enlightenment, the ${analysis.projectName} system represented the pinnacle of technological achievement. With ${analysis.totalLines} lines of carefully crafted code, it stood as a testament to human ingenuity and the endless possibilities of artificial intelligence.`,
      
      fantasy: `Long ago, in the mystical realm of ${analysis.projectName}, where magic flowed through ${analysis.files.length} sacred scrolls of code, there lived algorithms and functions with extraordinary powers. Each had a role to play in the grand tapestry of digital enchantment.`,
      
      documentary: `Welcome to an inside look at ${analysis.projectName}, a software project that demonstrates the complexities and beauty of modern development. Through ${analysis.files.length} files and ${analysis.totalLines} lines of code, we'll explore the technical decisions, architectural patterns, and human stories behind this codebase.`
    };

    return typeIntros[options.type as keyof typeof typeIntros] || typeIntros.adventure;
  }

  private generateCharacterIntroContent(analysis: any): string {
    const mainCharacters = analysis.characters.slice(0, 3);
    const introductions = mainCharacters.map((char: any) => 
      `Meet ${char.name}, ${char.role.toLowerCase()}. ${char.description} From their home in ${char.file}, ${char.name} would prove to be instrumental in the unfolding events.`
    ).join('\n\n');

    return `As our story unfolds, we encounter the key players in this digital drama:\n\n${introductions}\n\nEach character brought their own unique abilities and perspectives to the challenges ahead.`;
  }

  private generateProblemContent(analysis: any): string {
    const conflicts = analysis.conflicts.slice(0, 2);
    if (conflicts.length === 0) {
      return "The system was running smoothly, but beneath the surface, new challenges were beginning to emerge. Complexity was growing, and the need for optimization became increasingly apparent.";
    }

    const problemDesc = conflicts.map((conflict: any) => 
      `In ${conflict.file}, a ${conflict.type} presented itself: ${conflict.description}`
    ).join('. ');

    return `The first signs of trouble appeared when our heroes encountered several obstacles. ${problemDesc}. These challenges would test their resolve and push them to find innovative solutions.`;
  }

  private generateConflictContent(analysis: any): string {
    const highPriorityConflicts = analysis.conflicts.filter((c: any) => c.severity === 'high');
    
    if (highPriorityConflicts.length > 0) {
      return `The situation escalated dramatically when critical issues emerged. ${highPriorityConflicts[0].description} This wasn't just a simple bug—it was a fundamental challenge that threatened the entire system's stability. Our heroes would need to dig deep into their knowledge and work together to overcome this formidable obstacle.`;
    }

    return "As complexity increased and interdependencies grew more intricate, our characters found themselves facing their greatest challenge yet. The very foundations of their digital world seemed to shift beneath them, requiring unprecedented cooperation and innovation.";
  }

  private generateComplexityContent(analysis: any): string {
    const complexity = analysis.complexity?.cyclomatic || 5;
    
    if (complexity > 8) {
      return "The deeper they ventured into the codebase, the more intricate the patterns became. Nested loops within conditional statements, complex algorithms processing vast amounts of data, and intricate dependency chains that seemed to stretch infinitely. Each function called upon others in an elaborate dance of digital choreography.";
    } else if (complexity > 5) {
      return "The architecture revealed itself as elegantly complex, with thoughtful abstractions and well-designed interfaces. While challenging to navigate, the structure showed the careful planning and consideration of its creators. Each component had its place in the greater symphony of functionality.";
    }

    return "What appeared complex at first glance revealed itself to be beautifully simple in design. Clean interfaces, clear separation of concerns, and intuitive naming conventions made the journey through the codebase surprisingly straightforward.";
  }

  private generateClimaxContent(analysis: any, options: StoryGenerationOptions): string {
    const climaxTemplates = {
      adventure: "The moment of truth arrived when our heroes stood before the most challenging algorithm in the entire system. With all their knowledge and experience, they prepared to face the ultimate test of their abilities.",
      
      mystery: "All the clues finally came together in a revelation that changed everything. The mysterious behavior wasn't a bug at all—it was an elegant solution to a problem so complex that its purpose had been forgotten over time.",
      
      scifi: "The artificial intelligence reached a critical decision point. All systems converged on this moment where the boundary between human logic and machine learning would determine the future of the entire platform.",
      
      fantasy: "In the heart of the digital realm, where the most powerful spells of computation resided, our heroes discovered the source of the magical energy that powered the entire kingdom of code.",
      
      documentary: "This pivotal moment in the project's development represents the culmination of months of careful planning, collaborative effort, and technical innovation. Here, we see the true artistry of software engineering in action."
    };

    return climaxTemplates[options.type as keyof typeof climaxTemplates] || climaxTemplates.adventure;
  }

  private generateSolutionContent(analysis: any): string {
    const solutionCount = analysis.plotPoints?.filter((p: any) => p.type === 'resolution').length || 1;
    
    if (solutionCount > 3) {
      return "Through collaboration and creative problem-solving, our heroes discovered not just one solution, but multiple elegant approaches to the challenges they faced. Each resolution built upon the previous one, creating a cascading effect of improvements throughout the system.";
    }

    return "With wisdom gained through their journey and the power of collective intelligence, our characters found the solution they had been seeking. It was simpler than they expected, yet more powerful than they could have imagined. The key had been there all along, waiting for the right perspective to unlock it.";
  }

  private generateConclusionContent(analysis: any, options: StoryGenerationOptions): string {
    const projectName = analysis.projectName;
    
    return `And so concludes our journey through ${projectName}. What began as a simple exploration became an epic tale of digital discovery, problem-solving, and growth. The ${analysis.files.length} files no longer seemed like mere code—they were the chapters of a story, each function a character with its own purpose and personality.

The codebase continued to evolve, ready for new adventures and challenges. Our heroes had learned that in the world of programming, every ending is simply a new beginning, every solution the foundation for the next great innovation.

As we close this chapter, we're reminded that behind every line of code is a human story—dreams of solving problems, creating something meaningful, and building bridges between the possible and the actual. ${projectName} stands as a testament to that enduring human spirit of creation and discovery.`;
  }

  private createPlotPoints(analysisPlotPoints: any[]): StoryPlotPoint[] {
    return analysisPlotPoints.map((point, index) => ({
      title: point.title,
      description: point.description,
      chapter: Math.floor((index / analysisPlotPoints.length) * 8),
      tension: point.importance,
      codeContext: point.codeContext
    }));
  }

  private extractStoryThemes(analysisThemes: any[]): string[] {
    return analysisThemes.slice(0, 5).map(theme => theme.name);
  }

  private createOpening(analysis: any, template: any): StoryScene {
    return {
      title: "The Beginning of Our Tale",
      content: template.opening.replace('...', ` of ${analysis.projectName}, where innovation meets implementation and dreams become digital reality.`),
      characters: analysis.characters.slice(0, 2).map((c: any) => c.name),
      significance: "Sets the stage for the entire narrative journey"
    };
  }

  private createClimax(analysis: any, type: string): StoryScene {
    const climaxTitles = {
      adventure: "The Ultimate Challenge",
      mystery: "The Great Revelation", 
      scifi: "The Singularity Moment",
      fantasy: "The Magical Culmination",
      documentary: "The Defining Moment"
    };

    return {
      title: climaxTitles[type as keyof typeof climaxTitles] || "The Pivotal Moment",
      content: "This was the moment everything came together—all the preparation, all the learning, all the challenges led to this decisive point where the true potential of the system would be revealed.",
      characters: analysis.characters.slice(0, 5).map((c: any) => c.name),
      significance: "The peak of narrative tension and technical complexity"
    };
  }

  private createResolution(analysis: any, type: string): StoryScene {
    return {
      title: "A New Dawn",
      content: `With wisdom earned through experience and challenges overcome through collaboration, ${analysis.projectName} emerged stronger and more capable than ever before. The journey had transformed not just the code, but the understanding of what was possible.`,
      characters: analysis.characters.map((c: any) => c.name),
      significance: "The satisfying conclusion that ties together all narrative threads"
    };
  }

  private generateChoices(analysis: any, type: string): StoryChoice[] {
    const choices: StoryChoice[] = [
      {
        id: "explore_functions",
        text: "🔍 Explore the main functions",
        consequence: "Discover the core logic and learn about system architecture",
        codeEffect: "Increases understanding of function relationships",
        nextScene: "function_exploration"
      },
      {
        id: "investigate_classes",
        text: "🏛️ Investigate the class hierarchies", 
        consequence: "Uncover object-oriented design patterns and inheritance structures",
        codeEffect: "Reveals class dependencies and inheritance chains",
        nextScene: "class_investigation"
      },
      {
        id: "debug_issues",
        text: "🐛 Debug the identified issues",
        consequence: "Tackle problems head-on and improve system reliability",
        codeEffect: "Reduces technical debt and improves code quality",
        nextScene: "debugging_session"
      },
      {
        id: "optimize_performance",
        text: "⚡ Optimize system performance",
        consequence: "Enhance efficiency and speed of operations",
        codeEffect: "Improves algorithm complexity and resource usage",
        nextScene: "optimization_quest"
      }
    ];

    return choices;
  }

  private selectCodeSnippets(analysis: any): CodeSnippet[] {
    const snippets: CodeSnippet[] = [];
    
    analysis.characters.slice(0, 5).forEach((char: any) => {
      if (char.codeSnippet) {
        snippets.push({
          code: char.codeSnippet,
          context: `From ${char.file}, introducing ${char.name}`,
          purpose: `Demonstrates the ${char.type} ${char.name} and its role as ${char.role}`,
          file: char.file
        });
      }
    });

    return snippets;
  }

  private selectChapterCodeSnippets(analysis: any, chapterIndex: number): CodeSnippet[] {
    const allSnippets = this.selectCodeSnippets(analysis);
    const snippetsPerChapter = Math.ceil(allSnippets.length / 8);
    const start = chapterIndex * snippetsPerChapter;
    return allSnippets.slice(start, start + snippetsPerChapter);
  }

  private selectChapterCharacters(characters: any[], chapterIndex: number): string[] {
    const charactersPerChapter = Math.ceil(characters.length / 8);
    const start = chapterIndex * charactersPerChapter;
    return characters.slice(start, start + charactersPerChapter).map(c => c.name);
  }

  private selectChapterThemes(themes: any[], focus: string): string[] {
    const themeMap = {
      introduction: ['discovery', 'beginning'],
      character_introduction: ['relationships', 'roles'],
      problem_development: ['challenges', 'complexity'],
      conflict: ['obstacles', 'tension'],
      complexity: ['depth', 'intricacy'],
      climax: ['culmination', 'peak'],
      solution: ['resolution', 'breakthrough'],
      conclusion: ['completion', 'transformation']
    };

    const focusThemes = themeMap[focus as keyof typeof themeMap] || [];
    const matchingThemes = themes.filter((theme: any) => 
      focusThemes.some(ft => theme.name.toLowerCase().includes(ft))
    );

    return matchingThemes.length > 0 ? matchingThemes.map((t: any) => t.name) : [themes[0]?.name].filter(Boolean);
  }

  private enhanceCharacterDescription(char: any): string {
    const enhancements = {
      function: `As a function, ${char.name} serves as a reliable problem-solver in the digital realm.`,
      class: `${char.name} stands as a sophisticated entity, embodying both data and behavior in perfect harmony.`,
      variable: `The constant ${char.name} provides unwavering stability in an ever-changing world of computation.`,
      module: `${char.name} acts as a bridge, connecting different parts of the system with seamless integration.`
    };

    const base = enhancements[char.type as keyof typeof enhancements] || char.description;
    return `${base} ${char.description}`;
  }

  private assignPersonality(char: any): string {
    const personalities = {
      function: ['Reliable and methodical', 'Quick and efficient', 'Careful and precise', 'Innovative and creative'],
      class: ['Wise and structured', 'Complex and multifaceted', 'Organized and systematic', 'Powerful and influential'],
      variable: ['Steady and dependable', 'Flexible and adaptable', 'Strong and unwavering', 'Supportive and helpful'],
      module: ['Diplomatic and connecting', 'Independent and self-sufficient', 'Collaborative and team-oriented', 'Specialized and expert']
    };

    const options = personalities[char.type as keyof typeof personalities] || personalities.function;
    return options[Math.floor(Math.random() * options.length)];
  }

  private generateCharacterArc(char: any): string {
    const arcs = [
      `${char.name} begins as a simple ${char.type} but grows to become essential to the system's success.`,
      `Through challenges and optimization, ${char.name} evolves from basic functionality to sophisticated problem-solving.`,
      `${char.name}'s journey involves learning to work with other components to achieve greater harmony.`,
      `Starting with a specific purpose, ${char.name} discovers unexpected abilities and broader responsibilities.`
    ];

    return arcs[Math.floor(Math.random() * arcs.length)];
  }

  private generateLinearNarrative(story: GeneratedStory, analysis: any): string {
    const narrative = [
      story.opening.content,
      '',
      story.chapters.map(chapter => 
        `## ${chapter.title}\n\n${chapter.content}`
      ).join('\n\n'),
      '',
      `## ${story.climax.title}`,
      story.climax.content,
      '',
      `## ${story.resolution.title}`,
      story.resolution.content
    ].join('\n');

    return narrative;
  }
}