#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { CreativeEcosystemCLI } from './cli.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';
import { SynergyEngine } from './synergy-engine.js';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

// Display ASCII art banner
console.log(chalk.rainbow(figlet.textSync('Creative Ecosystem', { horizontalLayout: 'full' })));
console.log(chalk.cyan('🌟 Unified platform that orchestrates all 5 creative Qwen-Code tools 🌟\n'));

program
  .name('creative-ecosystem')
  .description('Orchestrate all creative tools into synergistic workflows')
  .version('1.0.0');

program
  .command('workflow')
  .description('Execute a complete creative workflow')
  .argument('<workflow-type>', 'Type of workflow (dream-to-garden, code-symphony, living-documentation)')
  .argument('<project-path>', 'Path to project or starting point')
  .option('-o, --output <dir>', 'Output directory for all artifacts', './creative-output')
  .option('-c, --config <file>', 'Workflow configuration file', '')
  .action(async (workflowType, projectPath, options) => {
    const orchestrator = new WorkflowOrchestrator();
    
    try {
      console.log(chalk.blue('🌟 Starting creative workflow...'));
      const result = await orchestrator.executeWorkflow(workflowType, projectPath, options);
      
      console.log(chalk.green('✨ Creative workflow completed!'));
      console.log(chalk.yellow(`📁 Output saved to: ${options.output}`));
      console.log(chalk.cyan(`🎨 Generated: ${result.artifacts.join(', ')}`));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('orchestrate')
  .description('Orchestrate multiple tools in sequence')
  .argument('<tools>', 'Comma-separated list of tools to run')
  .argument('<input>', 'Input data or path')
  .option('-f, --flow <sequence>', 'Execution flow (sequential, parallel, hybrid)', 'sequential')
  .option('-i, --interactive', 'Interactive mode for each step', false)
  .action(async (tools, input, options) => {
    const orchestrator = new WorkflowOrchestrator();
    
    try {
      const toolList = tools.split(',').map(t => t.trim());
      console.log(chalk.blue(`🎭 Orchestrating tools: ${toolList.join(' → ')}`));
      
      const result = await orchestrator.orchestrateTools(toolList, input, options.flow, options.interactive);
      
      console.log(chalk.green('✨ Tool orchestration completed!'));
      console.log(chalk.yellow(`🔄 Flow: ${options.flow}`));
      console.log(chalk.cyan(`📊 Results: ${Object.keys(result).join(', ')}`));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('synergy')
  .description('Analyze and enhance synergy between tools')
  .argument('<project-path>', 'Path to project for synergy analysis')
  .option('-d, --depth <level>', 'Analysis depth (shallow, medium, deep)', 'medium')
  .option('-v, --visualize', 'Generate synergy visualization', false)
  .action(async (projectPath, options) => {
    const synergyEngine = new SynergyEngine();
    
    try {
      console.log(chalk.blue('🔗 Analyzing tool synergy...'));
      const synergy = await synergyEngine.analyzeSynergy(projectPath, options.depth);
      
      console.log(chalk.green('✨ Synergy analysis complete!'));
      console.log(chalk.yellow(`🔗 Synergy score: ${synergy.score}/100`));
      console.log(chalk.cyan(`💡 Recommendations: ${synergy.recommendations.length} suggestions`));
      
      if (options.visualize) {
        await synergyEngine.visualizeSynergy(synergy, `${projectPath}/synergy-visualization.png`);
        console.log(chalk.magenta(`🖼️  Visualization saved to: ${projectPath}/synergy-visualization.png`));
      }
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('interactive')
  .description('Interactive creative ecosystem session')
  .action(() => {
    render(<CreativeEcosystemCLI />);
  });

program.parse();