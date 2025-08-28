#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { NeuralGardenerCLI } from './cli.js';
import { PlantGrower } from './plant-grower.js';
import { ComplexityAnalyzer } from './complexity-analyzer.js';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

// Display ASCII art banner
console.log(chalk.green(figlet.textSync('Neural Gardener', { horizontalLayout: 'full' })));
console.log(chalk.cyan('🌱 AI that Grows Digital Plants from Code Complexity 🌱\n'));

program
  .name('neural-gardener')
  .description('Transform code complexity into beautiful digital gardens')
  .version('1.0.0');

program
  .command('grow')
  .description('Grow a digital plant from code complexity')
  .argument('<code-path>', 'Path to code file or directory')
  .option('-s, --species <type>', 'Plant species (tree, flower, vine, cactus)', 'tree')
  .option('-e, --environment <type>', 'Growth environment (forest, desert, aquatic, space)', 'forest')
  .option('-o, --output <file>', 'Output image file path', './digital-plant.png')
  .action(async (codePath, options) => {
    const grower = new PlantGrower();
    
    try {
      console.log(chalk.blue('🌱 Analyzing code complexity...'));
      const plant = await grower.growPlant(codePath, options.species, options.environment, options.output);
      
      console.log(chalk.green('✨ Digital plant grown successfully!'));
      console.log(chalk.yellow(`🖼️  Saved to: ${options.output}`));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('garden')
  .description('Create a complete digital garden from project')
  .argument('<project-path>', 'Path to project directory')
  .option('-t, --theme <style>', 'Garden theme (zen, wild, geometric, organic)', 'zen')
  .option('-s, --size <dimensions>', 'Garden size (small, medium, large)', 'medium')
  .action(async (projectPath, options) => {
    const grower = new PlantGrower();
    
    try {
      console.log(chalk.blue('🌿 Growing digital garden...'));
      const garden = await grower.createGarden(projectPath, options.theme, options.size);
      
      console.log(chalk.green('✨ Digital garden created!'));
      console.log(chalk.yellow(`🌱 ${garden.plantCount} plants grown`));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('interactive')
  .description('Interactive gardening session')
  .action(() => {
    render(<NeuralGardenerCLI />);
  });

program.parse();