#!/usr/bin/env node
/**
 * Test hook script for Stop events in Claude-compatible format.
 * Reads JSON from stdin and outputs Claude-compatible JSON response.
 */

const fs = require('fs');
const path = require('path');

// Read from stdin
let inputData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('readable', () => {
  let chunk;
  while ((chunk = process.stdin.read()) !== null) {
    inputData += chunk;
  }
});

process.stdin.on('end', () => {
  try {
    const input = JSON.parse(inputData);
    
    // Log the received input for debugging
    const logPath = '/tmp/qwen_hook_test.log';
    fs.appendFileSync(logPath, `Stop hook received: ${JSON.stringify(input)}\n`);
    
    // Check if this is a Stop event
    const hookEventName = input.hook_event_name || '';
    
    if (hookEventName === 'Stop' || hookEventName === 'SubagentStop') {
      // For stop events, check if completion criteria are met
      const stopHookActive = input.stop_hook_active || false;
      
      if (stopHookActive) {
        // If already in a stop hook, allow to prevent infinite loops
        console.log(JSON.stringify({
          "decision": "approve",
          "reason": "Stop hook already active, allowing to prevent infinite loop"
        }));
        process.exit(0);
      } else {
        // For testing purposes, block the stop with a reason
        console.log(JSON.stringify({
          "decision": "block",
          "reason": "Testing: Stop operation blocked for testing purposes"
        }));
        process.exit(0); // Exit 0 means success but decision is to block
      }
    } 
    // Handle other event types
    else {
      console.log(JSON.stringify({
        "hookSpecificOutput": {
          "hookEventName": hookEventName,
          "additionalContext": "Test Stop hook processed successfully"
        }
      }));
      process.exit(0);
    }
  } catch (error) {
    console.error('Error parsing JSON input:', error.message);
    process.exit(1);
  }
});