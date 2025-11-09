#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Log the received input for debugging
echo "UserPromptSubmit hook received: $input" >> /tmp/qwen_hook_test.log

# Extract the hook event name
hook_event_name=$(echo "$input" | jq -r '.hook_event_name')

if [ "$hook_event_name" = "UserPromptSubmit" ]; then
    # Extract the prompt text
    prompt=$(echo "$input" | jq -r '.prompt // ""')
    
    # Check if prompt contains sensitive information
    if [[ "$prompt" =~ (password|secret|key|token|api_key|secret_key) ]]; then
        # Block prompts with sensitive info
        echo '{"decision": "block", "reason": "Prompt contains potential sensitive information"}'
        exit 2  # Exit code 2 means blocking error in Claude protocol
    elif [[ "$prompt" =~ test ]]; then
        # Add additional context for test-related prompts
        current_time=$(date)
        echo '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Test context added at: '"$current_time"'"}, "systemMessage": "Test hook processed successfully"}'
        exit 0
    else
        # For all other prompts, allow with additional info
        echo '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Prompt processed by test hook"}, "continue": true}'
        exit 0
    fi
else
    # For other event types, just acknowledge
    echo '{"hookSpecificOutput": {"hookEventName": "'$hook_event_name'", "additionalContext": "Test UserPromptSubmit hook processed successfully"}}'
    exit 0
fi