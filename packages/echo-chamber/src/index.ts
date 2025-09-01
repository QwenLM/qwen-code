#!/usr/bin/env node

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { EchoChamberCLI } from './cli.js';
import { MusicComposer } from './music-composer.js';
import { CommentAnalyzer } from './comment-analyzer.js';
import chalk from 'chalk';
import figlet from 'figlet';

const program = new Command();

// Display ASCII art banner
console.log(chalk.green(figlet.textSync('Echo Chamber', { horizontalLayout: 'full' })));
console.log(chalk.cyan('🎵 AI that Creates Music from Code Comments 🎵\n'));

program
  .name('echo-chamber')
  .description('Transform code comments into musical compositions')
  .version('1.0.0');

program
  .command('compose')
  .description('Compose music from code comments')
  .argument('<code-path>', 'Path to code file or directory')
  .option('-g, --genre <style>', 'Musical genre (electronic, classical, jazz, rock)', 'electronic')
  .option('-t, --tempo <bpm>', 'Tempo in BPM', '120')
  .option('-o, --output <file>', 'Output MIDI file path', './code-music.mid')
  .action(async (codePath, options) => {
    const composer = new MusicComposer();
    
    try {
      console.log(chalk.blue('🎵 Analyzing code comments...'));
      const music = await composer.composeFromComments(codePath, options.genre, options.tempo, options.output);
      
      console.log(chalk.green('✨ Music composition complete!'));
      console.log(chalk.yellow(`🎼 Saved to: ${options.output}`));
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('jam')
  .description('Create an interactive music session from code')
  .argument('<code-path>', 'Path to code file or directory')
  .option('-i, --instrument <type>', 'Primary instrument (piano, synth, guitar)', 'synth')
  .option('-l, --loop', 'Enable looping playback', false)
  .action(async (codePath, options) => {
    const composer = new MusicComposer();
    
    try {
      console.log(chalk.blue('🎸 Starting code-inspired jam session...'));
      await composer.startJamSession(codePath, options.instrument, options.loop);
      
    } catch (error) {
      console.error(chalk.red('❌ Error:'), error);
    }
  });

program
  .command('interactive')
  .description('Interactive music creation session')
  .action(() => {
    render(<EchoChamberCLI />);
  });

program.parse();