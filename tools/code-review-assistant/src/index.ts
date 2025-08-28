#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { CodeReviewApp } from './ui/CodeReviewApp.js';
import { CodeReviewCLI } from './cli/CodeReviewCLI.js';
import { loadConfig } from './config/config.js';

const program = new Command();

program
  .name('qwen-review')
  .description('AI-powered code review assistant using Qwen Code')
  .version('1.0.0');

program
  .command('review')
  .description('Review code changes in current repository')
  .option('-b, --branch <branch>', 'Compare with specific branch', 'main')
  .option('-f, --files <files>', 'Review specific files (comma-separated)')
  .option('-g, --gui', 'Launch GUI interface')
  .option('-o, --output <format>', 'Output format (json, markdown, console)', 'console')
  .action(async (options) => {
    const config = await loadConfig();
    
    if (options.gui) {
      render(React.createElement(CodeReviewApp, { config, options }));
    } else {
      const cli = new CodeReviewCLI(config);
      await cli.review(options);
    }
  });

program
  .command('diff')
  .description('Review specific diff content')
  .argument('<diff>', 'Diff content or file path')
  .option('-o, --output <format>', 'Output format (json, markdown, console)', 'console')
  .action(async (diff, options) => {
    const config = await loadConfig();
    const cli = new CodeReviewCLI(config);
    await cli.reviewDiff(diff, options);
  });

program
  .command('pr')
  .description('Review pull request')
  .argument('<pr>', 'Pull request number or URL')
  .option('-o, --output <format>', 'Output format (json, markdown, console)', 'console')
  .action(async (pr, options) => {
    const config = await loadConfig();
    const cli = new CodeReviewCLI(config);
    await cli.reviewPR(pr, options);
  });

program.parse();