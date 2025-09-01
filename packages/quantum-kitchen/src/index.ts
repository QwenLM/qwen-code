#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { QuantumKitchenCLI } from './cli.js';
import { RecipeGenerator } from './recipe-generator.js';
import { CodeAnalyzer } from './code-analyzer.js';
import { MenuPlanner } from './menu-planner.js';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

// Display ASCII art banner
console.log(chalk.cyan(figlet.textSync('Quantum Kitchen', { horizontalLayout: 'full' })));
console.log(chalk.yellow('🍳 AI Chef that Generates Recipes from Code Patterns 🍳\n'));

program
  .name('quantum-kitchen')
  .description('Transform code patterns into delicious recipes')
  .version('1.0.0');

program
  .command('analyze')
  .description('Analyze code and generate recipe suggestions')
  .argument('<code-file>', 'Path to code file to analyze')
  .option('-c, --cuisine <style>', 'Preferred cuisine style', 'fusion')
  .option('-d, --difficulty <level>', 'Recipe difficulty (easy, medium, hard)', 'medium')
  .action(async (codeFile, options) => {
    const analyzer = new CodeAnalyzer();
    const recipeGen = new RecipeGenerator();
    
    try {
      console.log(chalk.blue('🔍 Analyzing code patterns...'));
      const patterns = await analyzer.analyzeCode(codeFile);
      
      console.log(chalk.green('✨ Code analysis complete!'));
      console.log(chalk.cyan('🍽️  Generating recipe...'));
      
      const recipe = await recipeGen.generateRecipe(patterns, options.cuisine, options.difficulty);
      
      console.log(chalk.yellow('\n📜 Generated Recipe:'));
      console.log(recipe);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('cook')
  .description('Generate recipe from code snippet')
  .argument('<code-snippet>', 'Code snippet to transform into recipe')
  .option('-t, --type <dish>', 'Type of dish (appetizer, main, dessert)', 'main')
  .option('-s, --servings <count>', 'Number of servings', '4')
  .action(async (codeSnippet, options) => {
    const recipeGen = new RecipeGenerator();
    
    try {
      console.log(chalk.blue('👨‍🍳 Cooking up a recipe from your code...'));
      const recipe = await recipeGen.generateFromSnippet(codeSnippet, options.type, options.servings);
      
      console.log(chalk.yellow('\n📜 Your Code-Inspired Recipe:'));
      console.log(recipe);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('menu')
  .description('Generate a complete menu from project structure')
  .argument('<project-path>', 'Path to project directory')
  .option('-t, --theme <theme>', 'Menu theme (breakfast, lunch, dinner, party)', 'dinner')
  .option('-p, --people <count>', 'Number of people', '6')
  .action(async (projectPath, options) => {
    const menuPlanner = new MenuPlanner();
    
    try {
      console.log(chalk.blue('📋 Planning your code-inspired menu...'));
      const menu = await menuPlanner.generateMenu(projectPath, options.theme, options.people);
      
      console.log(chalk.yellow('\n🍽️  Your Code-Inspired Menu:'));
      console.log(menu);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('interactive')
  .description('Interactive cooking session')
  .action(() => {
    render(<QuantumKitchenCLI />);
  });

program.parse();