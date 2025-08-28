import { QwenCodeCore } from '@qwen-code/qwen-code-core';

export class DreamCodeGenerator {
  private qwenCore: QwenCodeCore;

  constructor() {
    this.qwenCore = new QwenCodeCore();
  }

  async generateCode(dreamConcept: string, language: string, codeType: string): Promise<string> {
    console.log(`💭 Generating ${codeType} code in ${language} based on: "${dreamConcept}"`);
    
    const prompt = this.buildPrompt(dreamConcept, language, codeType);
    
    try {
      // Use Qwen-Code to generate creative code
      const response = await this.qwenCore.generateCode(prompt);
      
      console.log('✨ Code generated successfully!');
      console.log('🎨 Your dream has inspired new creative possibilities');
      
      return response;
    } catch (error) {
      console.error('❌ Failed to generate code:', error);
      return this.generateFallbackCode(dreamConcept, language, codeType);
    }
  }

  private buildPrompt(dreamConcept: string, language: string, codeType: string): string {
    const basePrompt = `Create ${codeType} code in ${language} that embodies the essence of this dream concept: "${dreamConcept}".
    
    The code should be:
    - Creative and imaginative
    - Inspired by the dream's symbolism
    - Functional and well-structured
    - Include meaningful comments explaining the dream connection
    
    Make it feel like the dream has been translated into code.`;

    switch (codeType) {
      case 'function':
        return `${basePrompt} Create a function that processes or represents the dream concept.`;
      
      case 'class':
        return `${basePrompt} Create a class that models the dream concept with properties and methods.`;
      
      case 'app':
        return `${basePrompt} Create a complete application that visualizes or interacts with the dream concept.`;
      
      case 'art':
        return `${basePrompt} Create generative art code that visually represents the dream concept.`;
      
      default:
        return basePrompt;
    }
  }

  private generateFallbackCode(dreamConcept: string, language: string, codeType: string): string {
    // Fallback code generation when Qwen-Code is unavailable
    const concept = dreamConcept.toLowerCase();
    
    if (language === 'javascript' || language === 'typescript') {
      return this.generateJavaScriptFallback(concept, codeType);
    } else if (language === 'python') {
      return this.generatePythonFallback(concept, codeType);
    } else {
      return this.generateGenericFallback(concept, codeType);
    }
  }

  private generateJavaScriptFallback(concept: string, codeType: string): string {
    if (codeType === 'function') {
      return `// Dream-inspired function: ${concept}
function processDreamConcept(input) {
  // This function embodies the essence of: ${concept}
  const dreamElements = {
    concept: '${concept}',
    timestamp: new Date(),
    inspiration: 'Generated from dream symbolism'
  };
  
  // Transform input based on dream concept
  if (input.includes('light')) {
    return { ...dreamElements, result: 'illuminated', intensity: 'bright' };
  } else if (input.includes('water')) {
    return { ...dreamElements, result: 'flowing', intensity: 'fluid' };
  } else if (input.includes('flying')) {
    return { ...dreamElements, result: 'elevated', intensity: 'weightless' };
  }
  
  return { ...dreamElements, result: 'transformed', intensity: 'mystical' };
}

// Example usage
console.log(processDreamConcept('I dreamed of flying through light'));
console.log(processDreamConcept('Water flowing in the darkness'));`;
    }
    
    if (codeType === 'class') {
      return `// Dream-inspired class: ${concept}
class DreamConcept {
  constructor(concept, intensity = 'medium') {
    this.concept = concept;
    this.intensity = intensity;
    this.timestamp = new Date();
    this.inspiration = 'Generated from dream symbolism';
  }
  
  transform(input) {
    // Transform based on dream concept
    const transformations = {
      'light': 'illuminated',
      'water': 'flowing', 
      'flying': 'elevated',
      'forest': 'organic',
      'machine': 'mechanical'
    };
    
    for (const [key, value] of Object.entries(transformations)) {
      if (input.toLowerCase().includes(key)) {
        return { ...this, result: value, input };
      }
    }
    
    return { ...this, result: 'mystical', input };
  }
  
  visualize() {
    return \`🌙 Dream Concept: \${this.concept}
✨ Intensity: \${this.intensity}
🕐 Timestamp: \${this.timestamp}
💭 Inspiration: \${this.inspiration}\`;
  }
}

// Example usage
const dream = new DreamConcept('${concept}', 'high');
console.log(dream.transform('I saw light in my dream'));
console.log(dream.visualize());`;
    }
    
    return `// Dream-inspired code: ${concept}
console.log('🌙 Your dream of ${concept} has inspired this code');
console.log('✨ Let your imagination flow through the code');
console.log('💭 Every line is a step toward creative realization');`;
  }

  private generatePythonFallback(concept: string, codeType: string): string {
    if (codeType === 'function') {
      return `# Dream-inspired function: {concept}
def process_dream_concept(input_text):
    """
    This function embodies the essence of: {concept}
    Transform input based on dream symbolism
    """
    dream_elements = {{
        'concept': '{concept}',
        'timestamp': datetime.now(),
        'inspiration': 'Generated from dream symbolism'
    }}
    
    # Transform input based on dream concept
    if 'light' in input_text.lower():
        return {{**dream_elements, 'result': 'illuminated', 'intensity': 'bright'}}
    elif 'water' in input_text.lower():
        return {{**dream_elements, 'result': 'flowing', 'intensity': 'fluid'}}
    elif 'flying' in input_text.lower():
        return {{**dream_elements, 'result': 'elevated', 'intensity': 'weightless'}}
    
    return {{**dream_elements, 'result': 'transformed', 'intensity': 'mystical'}}

# Example usage
from datetime import datetime
print(process_dream_concept('I dreamed of flying through light'))
print(process_dream_concept('Water flowing in the darkness'))`;
    }
    
    return `# Dream-inspired code: {concept}
print('🌙 Your dream of {concept} has inspired this code')
print('✨ Let your imagination flow through the code')
print('💭 Every line is a step toward creative realization')`;
  }

  private generateGenericFallback(concept: string, codeType: string): string {
    return `// Dream-inspired code: ${concept}
// Your dream of ${concept} has inspired this code
// Let your imagination flow through the code
// Every line is a step toward creative realization

/*
  Dream Concept: ${concept}
  Code Type: ${codeType}
  Inspiration: Generated from dream symbolism
  
  This code represents the transformation of your dream
  into a tangible, creative expression.
*/`;
  }
}