/**
 * Test script for /chat command
 */

import { chatCommand } from './packages/cli/src/ui/commands/chatCommand.js';

// 测试命令解析
function testParseCommand() {
  const { parseSlashCommand } = await import('./packages/cli/src/utils/commands.js');
  
  const commands = [chatCommand];
  
  // 测试 /chat list
  const result1 = parseSlashCommand('/chat list', commands);
  console.log('/chat list 解析结果:');
  console.log('  commandToExecute:', result1.commandToExecute?.name);
  console.log('  args:', JSON.stringify(result1.args));
  console.log('  canonicalPath:', result1.canonicalPath);
  
  // 测试 /chat save my-session
  const result2 = parseSlashCommand('/chat save my-session', commands);
  console.log('\n/chat save my-session 解析结果:');
  console.log('  commandToExecute:', result2.commandToExecute?.name);
  console.log('  args:', JSON.stringify(result2.args));
  console.log('  canonicalPath:', result2.canonicalPath);
  
  // 测试 /chat resume my-session
  const result3 = parseSlashCommand('/chat resume my-session', commands);
  console.log('\n/chat resume my-session 解析结果:');
  console.log('  commandToExecute:', result3.commandToExecute?.name);
  console.log('  args:', JSON.stringify(result3.args));
  console.log('  canonicalPath:', result3.canonicalPath);
  
  // 测试 /chat delete my-session
  const result4 = parseSlashCommand('/chat delete my-session', commands);
  console.log('\n/chat delete my-session 解析结果:');
  console.log('  commandToExecute:', result4.commandToExecute?.name);
  console.log('  args:', JSON.stringify(result4.args));
  console.log('  canonicalPath:', result4.canonicalPath);
}

testParseCommand().catch(console.error);
