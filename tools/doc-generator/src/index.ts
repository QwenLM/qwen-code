#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { DocGeneratorApp } from './ui/DocGeneratorApp.js';
import { DocGeneratorCLI } from './cli/DocGeneratorCLI.js';
import { loadConfig } from './config/config.js';

const program = new Command();

program
  .name('qwen-docs')
  .description('AI-powered documentation generator using Qwen Code')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate documentation for the current project')
  .option('-t, --type <type>', 'Documentation type (api, readme, guides, all)', 'all')
  .option('-o, --output <dir>', 'Output directory for documentation', './docs')
  .option('-f, --format <format>', 'Output format (markdown, html, pdf)', 'markdown')
  .option('-g, --gui', 'Launch GUI interface')
  .option('-c, --config <file>', 'Configuration file path')
  .action(async (options) => {
    const config = await loadConfig(options.config);
    
    if (options.gui) {
      render(React.createElement(DocGeneratorApp, { config, options }));
    } else {
      const cli = new DocGeneratorCLI(config);
      await cli.generate(options);
    }
  });

program
  .command('update')
  .description('Update existing documentation')
  .option('-f, --force', 'Force update all documentation')
  .option('-o, --output <dir>', 'Output directory for documentation', './docs')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new DocGeneratorCLI(config);
    await cli.update(options);
  });

program
  .command('serve')
  .description('Serve documentation locally')
  .option('-p, --port <port>', 'Port to serve on', '3000')
  .option('-o, --output <dir>', 'Documentation directory to serve', './docs')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new DocGeneratorCLI(config);
    await cli.serve(options);
  });

program
  .command('config')
  .description('Configure documentation generation settings')
  .option('-e, --edit', 'Edit configuration in default editor')
  .option('-s, --show', 'Show current configuration')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new DocGeneratorCLI(config);
    await cli.configure(options);
  });

program.parse();