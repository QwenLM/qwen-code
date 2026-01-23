/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

// Simple test script to validate the static insight generator
import { StaticInsightGenerator } from './generators/StaticInsightGenerator.js';
import path from 'path';
import os from 'os';

async function testStaticInsightGenerator() {
  console.log('Testing Static Insight Generator...');

  try {
    const generator = new StaticInsightGenerator();
    const projectsDir = path.join(os.homedir(), '.qwen', 'projects');

    console.log(`Processing projects in: ${projectsDir}`);

    // Generate insights
    const outputPath = await generator.generateStaticInsight(projectsDir);

    console.log(`✅ Insights generated successfully at: ${outputPath}`);

    // Check if file exists
    const exists = await generator.insightFileExists();
    console.log(`✅ File exists check: ${exists}`);

    if (exists) {
      const stats = await generator.getInsightFileStats();
      console.log(`✅ File size: ${stats.size} bytes, modified: ${stats.mtime}`);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testStaticInsightGenerator();
}