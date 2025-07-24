#!/usr/bin/env node

/**
 * Script to reproduce the "tool result labeled as user" bug in Qwen-Code
 * 
 * This bug causes tool responses to be serialized with role: "user" instead 
 * of role: "tool", leading to OpenAI API 400 errors.
 */

const { spawn } = require('child_process');

console.log('🐛 Reproducing Qwen-Code tool bug...');
console.log('Expected: Tool responses should have role: "tool"');
console.log('Actual: Tool responses have role: "user" causing API errors\n');

// Run the CLI with debug enabled to capture message payloads
const command = 'npm';
const args = [
  'run', 'start', '--', 
  '--openai-base-url', 'http://localhost:11434/v1',
  '--openai-api-key', 'dummy',
  '--model', 'qwen3:30b-a3b',
  '--prompt', 'Please read the test.txt file and summarize its contents',
  '--yolo'
];

const env = {
  ...process.env,
  QC_DUMP_PRE_INFER: '1'
};

console.log('Running command:', command, ...args);
console.log('Environment: QC_DUMP_PRE_INFER=1');
console.log('Debug files will be saved to .debug/\n');

const child = spawn(command, args, { 
  env, 
  stdio: 'inherit',
  cwd: process.cwd()
});

child.on('error', (error) => {
  console.error('❌ Error running reproduction script:', error);
  process.exit(1);
});

child.on('exit', (code) => {
  console.log(`\n🔍 Process exited with code: ${code}`);
  console.log('📁 Check .debug/ directory for message payload dumps');
  console.log('🐛 Look for role: "user" messages containing functionResponse objects');
  console.log('✅ Bug confirmed if tool responses have role: "user" instead of role: "tool"');
});