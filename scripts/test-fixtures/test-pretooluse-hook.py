#!/usr/bin/env python3
"""
Test hook script for PreToolUse events in Claude-compatible format.
Reads JSON from stdin and outputs Claude-compatible JSON response.
"""

import json
import sys
import os

def main():
    # Read JSON input from stdin
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("Error: Invalid JSON input", file=sys.stderr)
        sys.exit(1)

    # Log the received input for debugging
    with open('/tmp/qwen_hook_test.log', 'a') as f:
        f.write(f"PreToolUse hook received: {json.dumps(input_data)}\n")

    # Check if this is a PreToolUse event
    hook_event_name = input_data.get('hook_event_name', '')
    
    if hook_event_name == 'PreToolUse':
        tool_name = input_data.get('tool_name', '')
        tool_input = input_data.get('tool_input', {})
        
        # Auto-approve read_file operations
        if tool_name == 'read_file':
            response = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "Auto-approved read file operation for testing"
                }
            }
            print(json.dumps(response))
            sys.exit(0)
        
        # For write_file operations, ask for confirmation
        elif tool_name == 'write_file':
            response = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": "Please confirm write operation for testing"
                }
            }
            print(json.dumps(response))
            sys.exit(0)
        
        # For any other tool, deny with reason
        else:
            response = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"Blocking {tool_name} operation for testing"
                }
            }
            print(json.dumps(response))
            sys.exit(2)  # Exit code 2 means blocking error in Claude protocol
    
    # For any other event type, just acknowledge
    else:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": hook_event_name,
                "additionalContext": "Test PreToolUse hook processed successfully"
            }
        }))
        sys.exit(0)

if __name__ == "__main__":
    main()