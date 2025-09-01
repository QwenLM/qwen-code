import { QwenCodeCore } from '@qwen-code/qwen-code-core';

export class RecipeGenerator {
  private qwenCore: QwenCodeCore;

  constructor() {
    this.qwenCore = new QwenCodeCore();
  }

  async generateRecipe(patterns: any[], cuisine: string, difficulty: string): Promise<string> {
    const prompt = `Create a ${cuisine} cuisine recipe with ${difficulty} difficulty based on these code patterns: ${JSON.stringify(patterns)}.
    
    The recipe should:
    - Reflect the structure and complexity of the code
    - Use ingredients that metaphorically represent code elements
    - Include cooking steps that mirror the code execution flow
    - Be creative and unexpected yet delicious`;
    
    try {
      const response = await this.qwenCore.generateCode(prompt);
      return this.formatRecipe(response, patterns, cuisine, difficulty);
    } catch (error) {
      return this.generateFallbackRecipe(patterns, cuisine, difficulty);
    }
  }

  async generateFromSnippet(codeSnippet: string, dishType: string, servings: number): Promise<string> {
    const prompt = `Transform this code snippet into a ${dishType} recipe for ${servings} people: ${codeSnippet}`;
    
    try {
      const response = await this.qwenCore.generateCode(prompt);
      return this.formatRecipe(response, [], 'fusion', 'medium');
    } catch (error) {
      return this.generateFallbackFromSnippet(codeSnippet, dishType, servings);
    }
  }

  private formatRecipe(aiResponse: string, patterns: any[], cuisine: string, difficulty: string): string {
    return `🍳 ${cuisine.toUpperCase()} RECIPE (${difficulty.toUpperCase()})
${'='.repeat(50)}

${aiResponse}

${'='.repeat(50)}
✨ Generated from code patterns by Quantum Kitchen AI Chef`;
  }

  private generateFallbackRecipe(patterns: any[], cuisine: string, difficulty: string): string {
    const patternNames = patterns.map(p => p.name || p.type).join(', ');
    
    return `🍳 ${cuisine.toUpperCase()} RECIPE (${difficulty.toUpperCase()})
${'='.repeat(50)}

INGREDIENTS:
- 2 cups of algorithmic flour
- 1 cup of recursive sugar
- 3 eggs of object-oriented thinking
- 1 tsp of functional programming salt
- 1/2 cup of asynchronous milk
- 1/4 cup of quantum butter

INSTRUCTIONS:
1. Preheat your quantum oven to 350°F (177°C)
2. Mix the algorithmic flour with recursive sugar
3. Beat in the object-oriented eggs one at a time
4. Add functional programming salt and asynchronous milk
5. Fold in quantum butter until smooth
6. Bake for 25-30 minutes until golden brown

NOTES:
This recipe was inspired by code patterns: ${patternNames}
The complexity reflects the ${difficulty} difficulty level
Serves 4-6 developers with a taste for innovation

${'='.repeat(50)}
✨ Generated from code patterns by Quantum Kitchen AI Chef`;
  }

  private generateFallbackFromSnippet(codeSnippet: string, dishType: string, servings: number): string {
    const codeLength = codeSnippet.length;
    const complexity = codeLength > 100 ? 'complex' : codeLength > 50 ? 'medium' : 'simple';
    
    return `🍳 ${dishType.toUpperCase()} RECIPE (${complexity.toUpperCase()})
${'='.repeat(50)}

INGREDIENTS:
- ${Math.ceil(codeLength / 10)} cups of code-inspired flour
- ${Math.ceil(servings / 2)} cups of creative sugar
- ${servings} eggs of innovation
- 1 tsp of debugging salt
- 1/2 cup of optimization milk
- 1/4 cup of refactoring butter

INSTRUCTIONS:
1. Preheat your development oven to 375°F (190°C)
2. Mix the code-inspired flour with creative sugar
3. Beat in the innovation eggs one at a time
4. Add debugging salt and optimization milk
5. Fold in refactoring butter until smooth
6. Bake for 20-25 minutes until perfectly structured

NOTES:
Inspired by: ${codeSnippet.substring(0, 50)}...
Code complexity: ${codeLength} characters
Serves ${servings} hungry developers

${'='.repeat(50)}
✨ Generated from code snippet by Quantum Kitchen AI Chef`;
  }
}