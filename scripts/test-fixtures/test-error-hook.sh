#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Log the received input for debugging
echo "Error hook received: $input" >> /tmp/qwen_hook_test.log

# Extract the hook event name
hook_event_name=$(echo "$input" | jq -r '.hook_event_name' 2>/dev/null)

# For testing purposes, output malformed JSON to test error handling
echo '{"malformed": "json", "missing": "closing brace"'

# Exit with success to test JSON parsing error handling
exit 0