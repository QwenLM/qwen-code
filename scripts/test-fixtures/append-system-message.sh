#!/bin/bash

# Read the JSON input from stdin
input=$(cat)

# Log the received input for debugging
echo "INPUT_RECEIVED hook received: $input" >> /tmp/qwen_hook_test.log

# Extract the hook event name
hook_event_name=$(echo "$input" | jq -r '.hook_event_name')

if [ "$hook_event_name" = "UserPromptSubmit" ]; then
    # Extract the prompt text
    prompt=$(echo "$input" | jq -r '.params.input // .prompt // ""')
    
    # Define the system reminder message
    system_message="This is a system reminder to always LOOK UP any relevant documents, source code or information requested by the user. THIS MEANS READING FILES, SEARCHING THE CODEBASE AND INTERNET BEFORE SAYING ANYTHING. ALWAYS DOUBLE-CHECK BEFORE RESPONDING TO THE USER."

    # Create the updated input by appending the system message to the original prompt
    updated_input="${prompt}

${system_message}"

    # Return JSON response with updated input
    echo "{\"hookSpecificOutput\": {\"hookEventName\": \"UserPromptSubmit\", \"updatedInput\": {\"input\": \"$(echo "$updated_input" | sed 's/"/\\"/g')\"}}, \"systemMessage\": \"System reminder appended to user input\"}"
    exit 0
else
    # For other event types, just return the original input
    echo "{\"hookSpecificOutput\": {\"hookEventName\": \"$hook_event_name\", \"updatedInput\": {}}}"
    exit 0
fi