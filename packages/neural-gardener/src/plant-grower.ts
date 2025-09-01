import { QwenCodeCore } from '@qwen-code/qwen-code-core';
import { ComplexityAnalyzer } from './complexity-analyzer.js';
import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

interface PlantCharacteristics {
  height: number;
  branches: number;
  leaves: number;
  color: string;
  complexity: number;
  growthPattern: string;
}

export class PlantGrower {
  private qwenCore: QwenCodeCore;
  private complexityAnalyzer: ComplexityAnalyzer;

  constructor() {
    this.qwenCore = new QwenCodeCore();
    this.complexityAnalyzer = new ComplexityAnalyzer();
  }

  async growPlant(codePath: string, species: string, environment: string, outputPath: string): Promise<PlantCharacteristics> {
    try {
      // Analyze code complexity
      const complexity = await this.complexityAnalyzer.analyzeComplexity(codePath);
      
      // Generate plant using Qwen-Code
      const plantPrompt = this.buildPlantPrompt(complexity, species, environment);
      const plantCode = await this.qwenCore.generateCode(plantPrompt);
      
      // Create digital plant visualization
      const plant = this.createDigitalPlant(complexity, species, environment);
      this.renderPlant(plant, outputPath);
      
      return plant;
      
    } catch (error) {
      console.error('Error growing plant:', error);
      return this.generateFallbackPlant(codePath, species, environment);
    }
  }

  async createGarden(projectPath: string, theme: string, size: string): Promise<any> {
    try {
      const complexity = await this.complexityAnalyzer.analyzeProjectComplexity(projectPath);
      const plants = [];
      
      // Create multiple plants based on project structure
      Object.keys(complexity.files).forEach((filePath, index) => {
        const fileComplexity = complexity.files[filePath];
        const species = this.selectSpecies(fileComplexity);
        const environment = this.selectEnvironment(theme);
        
        const plant = this.createDigitalPlant(fileComplexity, species, environment);
        plants.push({
          file: filePath,
          plant,
          complexity: fileComplexity
        });
      });
      
      // Create garden layout
      const garden = this.createGardenLayout(plants, theme, size);
      this.renderGarden(garden, `${projectPath}/digital-garden.png`);
      
      return {
        plantCount: plants.length,
        theme,
        size,
        totalComplexity: complexity.total,
        plants
      };
      
    } catch (error) {
      console.error('Error creating garden:', error);
      return { plantCount: 0, error: 'Failed to create garden' };
    }
  }

  private createDigitalPlant(complexity: any, species: string, environment: string): PlantCharacteristics {
    const baseComplexity = complexity.cyclomatic || complexity.lines || 10;
    
    const plant: PlantCharacteristics = {
      height: Math.min(baseComplexity * 2, 200),
      branches: Math.min(Math.floor(baseComplexity / 2), 20),
      leaves: Math.min(baseComplexity * 3, 100),
      color: this.selectColor(environment, species),
      complexity: baseComplexity,
      growthPattern: this.selectGrowthPattern(complexity, species)
    };
    
    return plant;
  }

  private selectSpecies(complexity: any): string {
    const complexityScore = complexity.cyclomatic || complexity.lines || 10;
    
    if (complexityScore < 5) return 'flower';
    if (complexityScore < 15) return 'vine';
    if (complexityScore < 30) return 'tree';
    return 'cactus';
  }

  private selectEnvironment(theme: string): string {
    const environmentMap = {
      zen: 'forest',
      wild: 'space',
      geometric: 'desert',
      organic: 'aquatic'
    };
    
    return environmentMap[theme] || 'forest';
  }

  private selectColor(environment: string, species: string): string {
    const colorMap = {
      forest: { tree: '#228B22', flower: '#FF69B4', vine: '#32CD32', cactus: '#90EE90' },
      desert: { tree: '#8B4513', flower: '#FFD700', vine: '#DAA520', cactus: '#228B22' },
      aquatic: { tree: '#006994', flower: '#87CEEB', vine: '#20B2AA', cactus: '#48D1CC' },
      space: { tree: '#4B0082', flower: '#9370DB', vine: '#8A2BE2', cactus: '#9932CC' }
    };
    
    return colorMap[environment]?.[species] || '#228B22';
  }

  private selectGrowthPattern(complexity: any, species: string): string {
    const patterns = {
      flower: complexity.cyclomatic > 10 ? 'spiral' : 'radial',
      vine: complexity.nesting > 3 ? 'twisting' : 'straight',
      tree: complexity.branches > 5 ? 'branching' : 'single',
      cactus: complexity.conditions > 8 ? 'segmented' : 'columnar'
    };
    
    return patterns[species] || 'natural';
  }

  private buildPlantPrompt(complexity: any, species: string, environment: string): string {
    return `Create a digital plant growth algorithm for a ${species} in a ${environment} environment based on this code complexity:

Complexity Analysis:
- Cyclomatic complexity: ${complexity.cyclomatic || 'unknown'}
- Lines of code: ${complexity.lines || 'unknown'}
- Nesting depth: ${complexity.nesting || 'unknown'}
- Function count: ${complexity.functions || 'unknown'}

The plant should:
- Have growth patterns that reflect the code complexity
- Use the ${species} species characteristics
- Adapt to the ${environment} environment
- Include realistic growth algorithms
- Generate visually appealing digital plants

Create creative code that transforms code complexity into beautiful digital flora.`;
  }

  private renderPlant(plant: PlantCharacteristics, outputPath: string): void {
    const canvas = createCanvas(400, 400);
    const ctx = canvas.getContext('2d');
    
    // Clear canvas
    ctx.fillStyle = '#87CEEB';
    ctx.fillRect(0, 0, 400, 400);
    
    // Draw ground
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(0, 350, 400, 50);
    
    // Draw plant based on characteristics
    this.drawPlant(ctx, plant);
    
    // Save the image
    const buffer = canvas.toBuffer('image/png');
    writeFileSync(outputPath, buffer);
  }

  private drawPlant(ctx: any, plant: PlantCharacteristics): void {
    const centerX = 200;
    const baseY = 350;
    
    ctx.strokeStyle = '#654321';
    ctx.lineWidth = 3;
    
    // Draw trunk/stem
    ctx.beginPath();
    ctx.moveTo(centerX, baseY);
    ctx.lineTo(centerX, baseY - plant.height);
    ctx.stroke();
    
    // Draw branches/leaves based on species
    if (plant.growthPattern === 'branching') {
      this.drawBranches(ctx, centerX, baseY - plant.height, plant);
    } else if (plant.growthPattern === 'spiral') {
      this.drawSpiralGrowth(ctx, centerX, baseY - plant.height, plant);
    } else if (plant.growthPattern === 'radial') {
      this.drawRadialGrowth(ctx, centerX, baseY - plant.height, plant);
    } else {
      this.drawNaturalGrowth(ctx, centerX, baseY - plant.height, plant);
    }
  }

  private drawBranches(ctx: any, x: number, y: number, plant: PlantCharacteristics): void {
    for (let i = 0; i < plant.branches; i++) {
      const angle = (i / plant.branches) * Math.PI * 2;
      const length = plant.height * 0.3;
      const endX = x + Math.cos(angle) * length;
      const endY = y + Math.sin(angle) * length;
      
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      
      // Draw leaves on branches
      this.drawLeaves(ctx, endX, endY, plant.leaves / plant.branches);
    }
  }

  private drawSpiralGrowth(ctx: any, x: number, y: number, plant: PlantCharacteristics): void {
    ctx.fillStyle = plant.color;
    
    for (let i = 0; i < plant.leaves; i++) {
      const angle = i * 0.5;
      const radius = i * 0.5;
      const leafX = x + Math.cos(angle) * radius;
      const leafY = y + Math.sin(angle) * radius;
      
      ctx.beginPath();
      ctx.arc(leafX, leafY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRadialGrowth(ctx: any, x: number, y: number, plant: PlantCharacteristics): void {
    ctx.fillStyle = plant.color;
    
    for (let i = 0; i < plant.leaves; i++) {
      const angle = (i / plant.leaves) * Math.PI * 2;
      const radius = plant.height * 0.4;
      const leafX = x + Math.cos(angle) * radius;
      const leafY = y + Math.sin(angle) * radius;
      
      ctx.beginPath();
      ctx.arc(leafX, leafY, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawNaturalGrowth(ctx: any, x: number, y: number, plant: PlantCharacteristics): void {
    ctx.fillStyle = plant.color;
    
    for (let i = 0; i < plant.leaves; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * plant.height * 0.5;
      const leafX = x + Math.cos(angle) * radius;
      const leafY = y + Math.sin(angle) * radius;
      
      ctx.beginPath();
      ctx.arc(leafX, leafY, 2 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawLeaves(ctx: any, x: number, y: number, count: number): void {
    ctx.fillStyle = '#228B22';
    
    for (let i = 0; i < count; i++) {
      const leafX = x + (Math.random() - 0.5) * 20;
      const leafY = y + (Math.random() - 0.5) * 20;
      
      ctx.beginPath();
      ctx.arc(leafX, leafY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private createGardenLayout(plants: any[], theme: string, size: string): any {
    const layout = {
      width: size === 'small' ? 800 : size === 'medium' ? 1200 : 1600,
      height: size === 'small' ? 600 : size === 'medium' ? 800 : 1000,
      plants,
      theme
    };
    
    return layout;
  }

  private renderGarden(garden: any, outputPath: string): void {
    const canvas = createCanvas(garden.width, garden.height);
    const ctx = canvas.getContext('2d');
    
    // Draw background based on theme
    this.drawGardenBackground(ctx, garden);
    
    // Position and draw plants
    this.positionPlants(ctx, garden);
    
    // Save the garden
    const buffer = canvas.toBuffer('image/png');
    writeFileSync(outputPath, buffer);
  }

  private drawGardenBackground(ctx: any, garden: any): void {
    const backgrounds = {
      zen: { sky: '#E6E6FA', ground: '#F5F5DC' },
      wild: { sky: '#2F4F4F', ground: '#556B2F' },
      geometric: { sky: '#F0F8FF', ground: '#D3D3D3' },
      organic: { sky: '#87CEEB', ground: '#90EE90' }
    };
    
    const bg = backgrounds[garden.theme] || backgrounds.zen;
    
    ctx.fillStyle = bg.sky;
    ctx.fillRect(0, 0, garden.width, garden.height * 0.7);
    
    ctx.fillStyle = bg.ground;
    ctx.fillRect(0, garden.height * 0.7, garden.width, garden.height * 0.3);
  }

  private positionPlants(ctx: any, garden: any): void {
    garden.plants.forEach((plantData: any, index: number) => {
      const x = (index % 5) * (garden.width / 5) + garden.width / 10;
      const y = garden.height * 0.7 - plantData.plant.height;
      
      // Save context and translate to plant position
      ctx.save();
      ctx.translate(x, y);
      
      // Draw the plant
      this.drawPlant(ctx, plantData.plant);
      
      // Restore context
      ctx.restore();
    });
  }

  private generateFallbackPlant(codePath: string, species: string, environment: string): PlantCharacteristics {
    return {
      height: 100,
      branches: 5,
      leaves: 25,
      color: '#228B22',
      complexity: 10,
      growthPattern: 'natural'
    };
  }
}