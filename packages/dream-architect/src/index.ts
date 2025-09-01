#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { DreamArchitectCLI } from './cli.js';
import { DreamVisualizer } from './visualizer.js';
import { DreamCodeGenerator } from './code-generator.js';

const program = new Command();

program
  .name('dream-architect')
  .description('AI-Powered Dream Visualization & Code Generator')
  .version('1.0.0');

program
  .command('visualize')
  .description('Visualize a dream using AI-generated art')
  .argument('<dream-description>', 'Description of your dream')
  .option('-s, --style <style>', 'Art style (surreal, abstract, realistic)', 'surreal')
  .option('-o, --output <path>', 'Output file path', './dream-art.png')
  .action(async (dreamDescription, options) => {
    const visualizer = new DreamVisualizer();
    await visualizer.visualizeDream(dreamDescription, options.style, options.output);
  });

program
  .command('code')
  .description('Generate code based on dream concepts')
  .argument('<dream-concept>', 'Core concept from your dream')
  .option('-l, --language <lang>', 'Programming language', 'javascript')
  .option('-t, --type <type>', 'Code type (function, class, app)', 'function')
  .action(async (dreamConcept, options) => {
    const generator = new DreamCodeGenerator();
    await generator.generateCode(dreamConcept, options.language, options.type);
  });

program
  .command('interactive')
  .description('Interactive dream exploration session')
  .action(() => {
    render(<DreamArchitectCLI />);
  });

program.parse();