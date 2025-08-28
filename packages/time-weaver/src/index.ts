#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { TimeWeaverCLI } from './cli.js';
import { StoryGenerator } from './story-generator.js';
import { TimelineAnalyzer } from './timeline-analyzer.js';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

// Display ASCII art banner
console.log(chalk.magenta(figlet.textSync('Time Weaver', { horizontalLayout: 'full' })));
console.log(chalk.cyan('⏰ AI that Generates Time Travel Stories from Git History ⏰\n'));

program
  .name('time-weaver')
  .description('Transform Git history into epic time travel narratives')
  .version('1.0.0');

program
  .command('story')
  .description('Generate a time travel story from Git commits')
  .argument('<repo-path>', 'Path to Git repository')
  .option('-g, --genre <style>', 'Story genre (scifi, fantasy, mystery, adventure)', 'scifi')
  .option('-l, --length <words>', 'Story length in words', '500')
  .option('-c, --commits <count>', 'Number of commits to analyze', '10')
  .action(async (repoPath, options) => {
    const storyGen = new StoryGenerator();
    
    try {
      console.log(chalk.blue('⏰ Analyzing Git timeline...'));
      const story = await storyGen.generateStory(repoPath, options.genre, options.length, options.commits);
      
      console.log(chalk.yellow('\n📖 Your Time Travel Story:'));
      console.log(story);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('timeline')
  .description('Analyze Git timeline and create story outline')
  .argument('<repo-path>', 'Path to Git repository')
  .option('-d, --days <count>', 'Number of days to analyze', '30')
  .option('-f, --format <type>', 'Output format (outline, summary, detailed)', 'outline')
  .action(async (repoPath, options) => {
    const timelineAnalyzer = new TimelineAnalyzer();
    
    try {
      console.log(chalk.blue('📅 Analyzing Git timeline...'));
      const timeline = await timelineAnalyzer.analyzeTimeline(repoPath, options.days, options.format);
      
      console.log(chalk.yellow('\n📅 Timeline Analysis:'));
      console.log(timeline);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('interactive')
  .description('Interactive story creation session')
  .action(() => {
    render(<TimeWeaverCLI />);
  });

program.parse();