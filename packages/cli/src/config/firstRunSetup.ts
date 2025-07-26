/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as readline from 'readline';
import { LoadedSettings, SettingScope } from './settings.js';

interface FirstRunConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModel: string;
}

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptForOpenAIConfig(): Promise<FirstRunConfig> {
  const rl = createReadlineInterface();
  
  console.log('\n🚀 Welcome to Qwen Code!');
  console.log('Please configure your OpenAI API settings:\n');

  try {
    const openaiApiKey = await askQuestion(
      rl,
      'Enter your OpenAI API Key: '
    );
    
    if (!openaiApiKey) {
      throw new Error('OpenAI API Key is required');
    }

    const openaiBaseUrl = await askQuestion(
      rl,
      'Enter OpenAI Base URL (press Enter for default: https://api.openai.com/v1): '
    );

    const openaiModel = await askQuestion(
      rl,
      'Enter OpenAI Model (press Enter for default: gpt-4): '
    );

    return {
      openaiApiKey,
      openaiBaseUrl: openaiBaseUrl || 'https://api.openai.com/v1',
      openaiModel: openaiModel || 'gpt-4',
    };
  } finally {
    rl.close();
  }
}

function isFirstRun(settings: LoadedSettings): boolean {
  const userSettings = settings.user.settings;
  
  // Check if OpenAI configuration is missing in both settings and environment
  return !userSettings.openaiApiKey && !process.env.OPENAI_API_KEY;
}

export async function handleFirstRunSetup(settings: LoadedSettings): Promise<void> {
  if (!isFirstRun(settings)) {
    return;
  }

  try {
    const config = await promptForOpenAIConfig();
    
    // Save the configuration to user settings
    settings.setValue(SettingScope.User, 'openaiApiKey', config.openaiApiKey);
    settings.setValue(SettingScope.User, 'openaiBaseUrl', config.openaiBaseUrl);
    settings.setValue(SettingScope.User, 'openaiModel', config.openaiModel);

    console.log('\n✅ Configuration saved successfully!');
    console.log(`Settings saved to: ${settings.user.path}\n`);
    
  } catch (error) {
    console.error('\n❌ Configuration setup failed:', error);
    process.exit(1);
  }
}