import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
import { DreamCodeGenerator } from './code-generator.js';

export class DreamVisualizer {
  private codeGenerator: DreamCodeGenerator;

  constructor() {
    this.codeGenerator = new DreamCodeGenerator();
  }

  async visualizeDream(description: string, style: string, outputPath: string): Promise<void> {
    console.log('🌙 Analyzing your dream...');
    
    // Use Qwen-Code to generate artistic code based on the dream
    const artisticPrompt = `Create a ${style} artistic visualization of this dream: "${description}". 
    Generate code that creates a beautiful, dreamlike image or animation. 
    Use creative algorithms, fractals, or generative art techniques.`;
    
    try {
      const artisticCode = await this.codeGenerator.generateCode(artisticPrompt, 'javascript', 'art');
      
      // Create a canvas-based visualization
      const canvas = createCanvas(800, 600);
      const ctx = canvas.getContext('2d');
      
      // Apply dream-inspired artistic effects
      this.applyDreamEffects(ctx, description, style);
      
      // Save the generated art
      const buffer = canvas.toBuffer('image/png');
      writeFileSync(outputPath, buffer);
      
      console.log(`✨ Dream art generated and saved to: ${outputPath}`);
      console.log('🎨 The AI has transformed your dream into visual reality!');
      
    } catch (error) {
      console.error('❌ Failed to visualize dream:', error);
    }
  }

  private applyDreamEffects(ctx: any, description: string, style: string): void {
    const canvas = ctx.canvas;
    
    // Create dream-inspired background
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    
    if (style === 'surreal') {
      gradient.addColorStop(0, '#1a0033');
      gradient.addColorStop(0.3, '#4d0099');
      gradient.addColorStop(0.7, '#9900cc');
      gradient.addColorStop(1, '#ff66ff');
    } else if (style === 'abstract') {
      gradient.addColorStop(0, '#000033');
      gradient.addColorStop(0.5, '#003366');
      gradient.addColorStop(1, '#66ccff');
    } else {
      gradient.addColorStop(0, '#2d4a3e');
      gradient.addColorStop(0.5, '#5a8c7a');
      gradient.addColorStop(1, '#a8d5ba');
    }
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Add dream symbols based on description
    this.addDreamSymbols(ctx, description);
    
    // Add floating particles
    this.addFloatingParticles(ctx);
    
    // Add ethereal light effects
    this.addLightEffects(ctx);
  }

  private addDreamSymbols(ctx: any, description: string): void {
    const symbols = this.extractSymbols(description);
    
    symbols.forEach((symbol, index) => {
      const x = 100 + (index * 150);
      const y = 200 + Math.sin(index * 0.5) * 100;
      
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = this.getSymbolColor(symbol);
      
      switch (symbol) {
        case 'flying':
          this.drawFlyingSymbol(ctx, x, y);
          break;
        case 'water':
          this.drawWaterSymbol(ctx, x, y);
          break;
        case 'forest':
          this.drawForestSymbol(ctx, x, y);
          break;
        case 'light':
          this.drawLightSymbol(ctx, x, y);
          break;
        default:
          this.drawGenericSymbol(ctx, x, y, symbol);
      }
      
      ctx.restore();
    });
  }

  private extractSymbols(description: string): string[] {
    const commonSymbols = ['flying', 'water', 'forest', 'light', 'shadow', 'building', 'animal'];
    return commonSymbols.filter(symbol => 
      description.toLowerCase().includes(symbol)
    );
  }

  private getSymbolColor(symbol: string): string {
    const colorMap: { [key: string]: string } = {
      'flying': '#ffd700',
      'water': '#00bfff',
      'forest': '#228b22',
      'light': '#ffff00',
      'shadow': '#4b0082',
      'building': '#8b4513',
      'animal': '#ff6347'
    };
    return colorMap[symbol] || '#ffffff';
  }

  private drawFlyingSymbol(ctx: any, x: number, y: number): void {
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
    
    // Add wings
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 30, y);
    ctx.quadraticCurveTo(x - 40, y - 20, x - 50, y);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x + 30, y);
    ctx.quadraticCurveTo(x + 40, y - 20, x + 50, y);
    ctx.stroke();
  }

  private drawWaterSymbol(ctx: any, x: number, y: number): void {
    ctx.strokeStyle = '#00bfff';
    ctx.lineWidth = 3;
    
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(x - 25 + i * 10, y);
      ctx.quadraticCurveTo(x - 20 + i * 10, y - 15, x - 15 + i * 10, y);
      ctx.stroke();
    }
  }

  private drawForestSymbol(ctx: any, x: number, y: number): void {
    ctx.fillStyle = '#228b22';
    
    // Draw trees
    for (let i = 0; i < 3; i++) {
      const treeX = x - 20 + i * 20;
      ctx.beginPath();
      ctx.moveTo(treeX, y + 20);
      ctx.lineTo(treeX - 10, y - 20);
      ctx.lineTo(treeX + 10, y - 20);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawLightSymbol(ctx: any, x: number, y: number): void {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, 30);
    gradient.addColorStop(0, '#ffff00');
    gradient.addColorStop(0.5, '#ffaa00');
    gradient.addColorStop(1, 'transparent');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawGenericSymbol(ctx: any, x: number, y: number, symbol: string): void {
    ctx.fillStyle = '#ffffff';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(symbol, x, y);
  }

  private addFloatingParticles(ctx: any): void {
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.6;
    
    for (let i = 0; i < 50; i++) {
      const x = Math.random() * ctx.canvas.width;
      const y = Math.random() * ctx.canvas.height;
      const size = Math.random() * 3 + 1;
      
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private addLightEffects(ctx: any): void {
    const gradient = ctx.createRadialGradient(
      ctx.canvas.width / 2, 
      ctx.canvas.height / 2, 
      0, 
      ctx.canvas.width / 2, 
      ctx.canvas.height / 2, 
      200
    );
    
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
    gradient.addColorStop(1, 'transparent');
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
}