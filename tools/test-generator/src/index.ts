#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { TestGeneratorApp } from './ui/TestGeneratorApp.js';
import { TestGeneratorCLI } from './cli/TestGeneratorCLI.js';
import { loadConfig } from './config/config.js';

const program = new Command();

program
  .name('qwen-test')
  .description('AI-powered test generator using Qwen Code')
  .version('1.0.0');

program
  .command('generate')
  .description('Generate tests for the current project')
  .option('-f, --files <files>', 'Specific files to generate tests for (comma-separated)')
  .option('-t, --type <type>', 'Test type (unit, integration, e2e, all)', 'all')
  .option('-o, --output <dir>', 'Output directory for tests', './tests')
  .option('-f, --framework <framework>', 'Test framework (jest, vitest, mocha)', 'jest')
  .option('-c, --coverage', 'Generate coverage configuration')
  .option('-g, --gui', 'Launch GUI interface')
  .option('-m, --mock', 'Generate mock data and stubs')
  .action(async (options) => {
    const config = await loadConfig();
    
    if (options.gui) {
      render(React.createElement(TestGeneratorApp, { config, options }));
    } else {
      const cli = new TestGeneratorCLI(config);
      await cli.generate(options);
    }
  });

program
  .command('update')
  .description('Update existing tests')
  .option('-f, --force', 'Force update all tests')
  .option('-o, --output <dir>', 'Test directory', './tests')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new TestGeneratorCLI(config);
    await cli.update(options);
  });

program
  .command('run')
  .description('Run generated tests')
  .option('-o, --output <dir>', 'Test directory', './tests')
  .option('-f, --framework <framework>', 'Test framework to use', 'jest')
  .option('-w, --watch', 'Run tests in watch mode')
  .option('-c, --coverage', 'Run with coverage')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new TestGeneratorCLI(config);
    await cli.run(options);
  });

program
  .command('analyze')
  .description('Analyze test coverage and quality')
  .option('-o, --output <dir>', 'Test directory', './tests')
  .option('-f, --framework <framework>', 'Test framework', 'jest')
  .action(async (options) => {
    const config = await loadConfig();
    const cli = new TestGeneratorCLI(config);
    await cli.analyze(options);
  });

program.parse();