import { DreamArchitect } from '@qwen-code/dream-architect';
import { QuantumKitchen } from '@qwen-code/quantum-kitchen';
import { TimeWeaver } from '@qwen-code/time-weaver';
import { EchoChamber } from '@qwen-code/echo-chamber';
import { NeuralGardener } from '@qwen-code/neural-gardener';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

interface WorkflowResult {
  artifacts: string[];
  metadata: any;
  synergy: number;
  recommendations: string[];
}

export class WorkflowOrchestrator {
  private dreamArchitect: DreamArchitect;
  private quantumKitchen: QuantumKitchen;
  private timeWeaver: TimeWeaver;
  private echoChamber: EchoChamber;
  private neuralGardener: NeuralGardener;

  constructor() {
    this.dreamArchitect = new DreamArchitect();
    this.quantumKitchen = new QuantumKitchen();
    this.timeWeaver = new TimeWeaver();
    this.echoChamber = new EchoChamber();
    this.neuralGardener = new NeuralGardener();
  }

  async executeWorkflow(workflowType: string, projectPath: string, options: any): Promise<WorkflowResult> {
    const outputDir = options.output || './creative-output';
    mkdirSync(outputDir, { recursive: true });

    switch (workflowType) {
      case 'dream-to-garden':
        return await this.executeDreamToGardenWorkflow(projectPath, outputDir);
      
      case 'code-symphony':
        return await this.executeCodeSymphonyWorkflow(projectPath, outputDir);
      
      case 'living-documentation':
        return await this.executeLivingDocumentationWorkflow(projectPath, outputDir);
      
      default:
        throw new Error(`Unknown workflow type: ${workflowType}`);
    }
  }

  async orchestrateTools(tools: string[], input: string, flow: string, interactive: boolean): Promise<any> {
    const results: any = {};
    
    if (flow === 'sequential') {
      // Execute tools in sequence, passing output from one to the next
      for (const tool of tools) {
        console.log(`🎭 Executing: ${tool}`);
        results[tool] = await this.executeTool(tool, input, interactive);
        
        // Use output as input for next tool
        if (results[tool] && results[tool].output) {
          input = results[tool].output;
        }
      }
    } else if (flow === 'parallel') {
      // Execute all tools simultaneously
      const promises = tools.map(tool => 
        this.executeTool(tool, input, interactive)
      );
      
      const parallelResults = await Promise.all(promises);
      tools.forEach((tool, index) => {
        results[tool] = parallelResults[index];
      });
    } else if (flow === 'hybrid') {
      // Execute some tools in parallel, then sequence others
      const parallelTools = tools.slice(0, Math.ceil(tools.length / 2));
      const sequentialTools = tools.slice(Math.ceil(tools.length / 2));
      
      // Execute first half in parallel
      const parallelPromises = parallelTools.map(tool => 
        this.executeTool(tool, input, interactive)
      );
      
      const parallelResults = await Promise.all(parallelPromises);
      parallelTools.forEach((tool, index) => {
        results[tool] = parallelResults[index];
      });
      
      // Execute second half sequentially
      let currentInput = input;
      for (const tool of sequentialTools) {
        results[tool] = await this.executeTool(tool, currentInput, interactive);
        if (results[tool] && results[tool].output) {
          currentInput = results[tool].output;
        }
      }
    }
    
    return results;
  }

  private async executeDreamToGardenWorkflow(projectPath: string, outputDir: string): Promise<WorkflowResult> {
    console.log('🌙 Starting Dream-to-Garden workflow...');
    
    // 1. Capture creative vision through dreams
    const dreamSession = await this.dreamArchitect.startInteractiveSession();
    const dreamOutput = join(outputDir, 'dream-session.json');
    writeFileSync(dreamOutput, JSON.stringify(dreamSession, null, 2));
    
    // 2. Generate code from dream concepts
    const dreamCode = await this.dreamArchitect.generateCode(
      dreamSession.concept, 'javascript', 'app'
    );
    const codeOutput = join(outputDir, 'dream-inspired-code.js');
    writeFileSync(codeOutput, dreamCode);
    
    // 3. Create recipe from the generated code
    const recipe = await this.quantumKitchen.generateRecipe(
      codeOutput, 'fusion', 'medium'
    );
    const recipeOutput = join(outputDir, 'code-inspired-recipe.txt');
    writeFileSync(recipeOutput, recipe);
    
    // 4. Generate time travel story from the development process
    const story = await this.timeWeaver.generateStory(
      projectPath, 'fantasy', 300, 5
    );
    const storyOutput = join(outputDir, 'development-story.txt');
    writeFileSync(storyOutput, story);
    
    // 5. Create music from the code comments
    const music = await this.echoChamber.composeFromComments(
      codeOutput, 'electronic', 120, join(outputDir, 'code-music.mid')
    );
    
    // 6. Grow digital garden from the code complexity
    const garden = await this.neuralGardener.createGarden(
      projectPath, 'organic', 'large'
    );
    
    return {
      artifacts: [
        'dream-session.json',
        'dream-inspired-code.js', 
        'code-inspired-recipe.txt',
        'development-story.txt',
        'code-music.mid',
        'digital-garden.png'
      ],
      metadata: {
        workflow: 'dream-to-garden',
        dreamConcept: dreamSession.concept,
        codeComplexity: garden.totalComplexity,
        plantCount: garden.plantCount
      },
      synergy: 95,
      recommendations: [
        'Use the generated code as a starting point for your project',
        'Cook the recipe while coding for enhanced creativity',
        'Listen to the generated music during development sessions',
        'Let the digital garden inspire your project architecture'
      ]
    };
  }

  private async executeCodeSymphonyWorkflow(projectPath: string, outputDir: string): Promise<WorkflowResult> {
    console.log('🎵 Starting Code Symphony workflow...');
    
    // 1. Analyze project complexity
    const complexity = await this.neuralGardener.analyzeProjectComplexity(projectPath);
    
    // 2. Generate music from code comments
    const music = await this.echoChamber.composeFromComments(
      projectPath, 'classical', 120, join(outputDir, 'project-symphony.mid')
    );
    
    // 3. Create recipes from different code patterns
    const recipes = [];
    for (const [file, fileComplexity] of Object.entries(complexity.files)) {
      const recipe = await this.quantumKitchen.generateRecipe(
        [fileComplexity], 'fusion', 'medium'
      );
      recipes.push({ file, recipe });
    }
    
    const recipesOutput = join(outputDir, 'code-recipes.json');
    writeFileSync(recipesOutput, JSON.stringify(recipes, null, 2));
    
    // 4. Generate stories from Git history
    const story = await this.timeWeaver.generateStory(
      projectPath, 'adventure', 400, 10
    );
    const storyOutput = join(outputDir, 'project-adventure.txt');
    writeFileSync(storyOutput, story);
    
    // 5. Grow themed garden
    const garden = await this.neuralGardener.createGarden(
      projectPath, 'geometric', 'large'
    );
    
    return {
      artifacts: [
        'project-symphony.mid',
        'code-recipes.json',
        'project-adventure.txt',
        'digital-garden.png'
      ],
      metadata: {
        workflow: 'code-symphony',
        totalComplexity: complexity.total,
        fileCount: Object.keys(complexity.files).length,
        plantCount: garden.plantCount
      },
      synergy: 92,
      recommendations: [
        'Use the symphony as background music during coding',
        'Cook recipes based on your current work focus',
        'Read the adventure story for project inspiration',
        'Let the geometric garden guide your code organization'
      ]
    };
  }

  private async executeLivingDocumentationWorkflow(projectPath: string, outputDir: string): Promise<WorkflowResult> {
    console.log('📚 Starting Living Documentation workflow...');
    
    // 1. Generate time travel story from project evolution
    const projectStory = await this.timeWeaver.generateStory(
      projectPath, 'mystery', 500, 15
    );
    const storyOutput = join(outputDir, 'project-evolution.txt');
    writeFileSync(storyOutput, projectStory);
    
    // 2. Create music that evolves with the project
    const evolutionMusic = await this.echoChamber.composeFromComments(
      projectPath, 'jazz', 90, join(outputDir, 'evolution-jazz.mid')
    );
    
    // 3. Generate recipes for different project phases
    const phaseRecipes = await this.quantumKitchen.generateProjectMenu(
      projectPath, 'progressive', 8
    );
    const recipesOutput = join(outputDir, 'phase-recipes.txt');
    writeFileSync(recipesOutput, phaseRecipes);
    
    // 4. Grow living garden that represents project health
    const livingGarden = await this.neuralGardener.createGarden(
      projectPath, 'zen', 'large'
    );
    
    // 5. Create dream-inspired documentation
    const documentationDream = await this.dreamArchitect.generateCode(
      'living documentation system', 'markdown', 'app'
    );
    const docOutput = join(outputDir, 'living-documentation.md');
    writeFileSync(docOutput, documentationDream);
    
    return {
      artifacts: [
        'project-evolution.txt',
        'evolution-jazz.mid',
        'phase-recipes.txt',
        'digital-garden.png',
        'living-documentation.md'
      ],
      metadata: {
        workflow: 'living-documentation',
        projectAge: 'evolving',
        documentationStyle: 'living',
        gardenTheme: 'zen'
      },
      synergy: 98,
      recommendations: [
        'Update the story as your project evolves',
        'Let the jazz music inspire your documentation rhythm',
        'Cook phase-appropriate recipes during milestones',
        'Maintain the garden to reflect project health',
        'Use the living documentation as your project compass'
      ]
    };
  }

  private async executeTool(tool: string, input: string, interactive: boolean): Promise<any> {
    try {
      switch (tool) {
        case 'dream-architect':
          return await this.dreamArchitect.startInteractiveSession();
        
        case 'quantum-kitchen':
          return await this.quantumKitchen.generateRecipe(
            [input], 'fusion', 'medium'
          );
        
        case 'time-weaver':
          return await this.timeWeaver.generateStory(
            input, 'fantasy', 200, 5
          );
        
        case 'echo-chamber':
          return await this.echoChamber.composeFromComments(
            input, 'electronic', 120, './temp-music.mid'
          );
        
        case 'neural-gardener':
          return await this.neuralGardener.growPlant(
            input, 'tree', 'forest', './temp-plant.png'
          );
        
        default:
          throw new Error(`Unknown tool: ${tool}`);
      }
    } catch (error) {
      console.error(`Error executing ${tool}:`, error);
      return { error: error.message, tool };
    }
  }
}